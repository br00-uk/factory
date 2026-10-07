import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import type { Store } from './storage.js';
import type { Workflow } from './workflow.js';
import type { Run } from './models.js';
import { clean, protectSecret } from './safety.js';

const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const user=z.object({id:integer,is_bot:z.boolean().optional()});
const chat=z.object({id:integer,type:z.literal('private')});
const message=z.object({message_id:integer,from:user.optional(),chat,
  text:z.string().max(10000).optional(),reply_to_message:z.object({message_id:integer}).optional()});
const Update=z.object({update_id:integer,message:message.optional(),
  callback_query:z.object({id:z.string().max(256),from:user,message:message.optional(),data:z.string().max(64).optional()}).optional()});
type Reference={run:string;context:string;request:string|null};
const context=(run:Run)=>run.status==='awaiting_plan_approval'?(run.planHash??run.source):(run.candidate?.hash??run.planHash??run.source);
const routingMessage=z.object({from:user.optional(),chat:z.object({id:z.number().int(),type:z.string()})});
const Routing=z.object({message:routingMessage.optional(),callback_query:z.object({from:user,message:routingMessage.optional()}).optional()});

export class Telegram {
  private readonly controller=new AbortController();
  private running:Promise<void>|undefined;
  private readonly token:string;
  constructor(readonly config:NonNullable<Config['telegram']>,private readonly store:Store,
    private readonly workflow:Workflow,private readonly fetcher:typeof fetch=fetch){
    const token=process.env[config.tokenEnv];if(!token)throw new Error(`Set Telegram credential reference ${config.tokenEnv}`);
    this.token=token;protectSecret(token);
    store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_updates(id INTEGER PRIMARY KEY,outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_messages(id INTEGER PRIMARY KEY,run TEXT NOT NULL REFERENCES runs(id),context TEXT NOT NULL,request TEXT);`);
  }
  start():void {if(!this.running)this.running=this.loop();}
  async ready():Promise<void>{
    z.object({id:integer,is_bot:z.literal(true)}).parse(await this.api('getMe',{}));
    const hook=z.object({url:z.string()}).parse(await this.api('getWebhookInfo',{}));
    if(hook.url)throw new Error('The configured bot has a webhook; use a dedicated polling bot without one');
    const target=chat.parse(await this.api('getChat',{chat_id:this.config.chatId}));
    if(target.id!==this.config.chatId)throw new Error('Configured Telegram private chat is unavailable');
  }
  async stop():Promise<void>{this.controller.abort();await this.running;}
  private async api(method:string,body:unknown):Promise<unknown>{
    try{
      const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
        signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(35000)])});
      if(!response.ok||!response.body)throw new Error(`HTTP ${response.status}`);
      let bytes=0;const chunks:Uint8Array[]=[];
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024*1024)throw new Error('Response too large');chunks.push(chunk);}
      const reply=z.object({ok:z.boolean(),result:z.unknown().optional()}).parse(JSON.parse(Buffer.concat(chunks).toString()));
      if(!reply.ok)throw new Error('Bot API refused request');return reply.result;
    }catch{throw new Error(`Telegram ${method} unavailable; local requests remain accessible`);}
  }
  private reference(id:number):Reference{
    const row=this.store.db.prepare('SELECT run,context,request FROM telegram_messages WHERE id=?').get(id) as Reference|undefined;
    if(!row)throw new Error('Unknown bot message reference');
    const run=this.workflow.getRun(row.run);
    if(context(run)!==row.context||['cancelled','ready_for_manual_merge'].includes(run.status))throw new Error('Obsolete bot message reference');
    if(row.request&&!this.store.requests(run.id).some(q=>q.id===row.request&&q.pending))throw new Error('Obsolete question reference');
    return row;
  }
  private summary(run:Run):string{
    return clean(`${run.id}: ${run.status}. Reserved spend $${run.spentUsd.toFixed(2)}. ${run.blocker??run.progress??''}\n`
      +(run.candidate?`Checks: ${run.candidate.checks.map(c=>`${c.name} ${c.outcome}`).join(', ')}. Full evidence and approvals stay in Herdr.`:''));
  }
  async receive(value:unknown):Promise<string>{
    const envelope=z.object({update_id:integer}).parse(value);
    let outcome='ignored';let effect:(()=>Promise<void>|void)|undefined;let callback:string|undefined;
    this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT 1 FROM telegram_updates WHERE id=?').get(envelope.update_id)){outcome='duplicate';return;}
      try{
        const routing=Routing.safeParse(value);const routed=routing.success?(routing.data.callback_query?.message??routing.data.message):undefined;
        const routedSender=routing.success?(routing.data.callback_query?.from??routed?.from):undefined;
        if(!routed||routedSender?.id!==this.config.userId||routedSender.is_bot||routed.chat.id!==this.config.chatId||routed.chat.type!=='private'){
          outcome='ignored';
        }else{
        const update=Update.parse(value);const incoming=update.callback_query?.message??update.message;
        const sender=update.callback_query?.from??incoming?.from;
        if(!incoming||sender?.id!==this.config.userId||sender.is_bot||incoming.chat.id!==this.config.chatId){outcome='ignored';}
        else{
          let text=clean(incoming.text??'');
          if(update.callback_query){
            const ref=this.reference(incoming.message_id);
            if(update.callback_query.data!==`pause:${ref.run}`)throw new Error('Unsupported or obsolete button');
            text=`/pause ${ref.run}`;callback=update.callback_query.id;
          }else if(!text.startsWith('/')){
            if(!incoming.reply_to_message)throw new Error('Reply to a current recorded bot question/review or use an explicit command');
            const ref=this.reference(incoming.reply_to_message.message_id);
            text=ref.request?`/answer ${ref.run} ${ref.request} ${text}`:`/changes ${ref.run} ${ref.context} ${text}`;
          }
          const [command,id,...args]=text.trim().split(/\s+/);
          if(!/^F-[a-f0-9]{12}$/.test(id??''))throw new Error('Current run ID required');
          const run=this.workflow.getRun(id!);
          if(['cancelled','ready_for_manual_merge'].includes(run.status))throw new Error('Run is terminal');
          if(command==='/answer'){
            const request=args.shift()??'';const answer=args.join(' ');if(!answer)throw new Error('Answer text required');
            const accepted=this.store.recordAnswer(run,request,answer);
            effect=()=>this.workflow.deliverAnswer(run,request,accepted.stage,answer);outcome='Answer saved; stopped work requires local resume.';
          }else if(command==='/steer'){
            const instruction=args.join(' ');if(!instruction)throw new Error('Steering text required');
            run.messages.push({kind:'steering',text:instruction,time:new Date().toISOString()});this.store.save(run);
            effect=()=>this.workflow.deliverSteering(run,instruction);outcome='Steering saved within the approved scope; expanded permissions require local revision.';
          }else if(command==='/changes'){
            const candidate=args.shift();const comments=args.join(' ');
            if(!comments||!['awaiting_plan_approval','awaiting_merge_approval'].includes(run.status)||context(run)!==candidate)throw new Error('Obsolete plan/candidate reference or missing comments');
            run.messages.push({kind:'revision',text:comments,time:new Date().toISOString()});this.store.revoke(run);
            run.blocker='Telegram change request saved; local revision required if replanning cannot start';this.store.save(run);
            effect=()=>this.workflow.revise(run,comments,true);outcome='Changes saved; a new plan requires local approval.';
          }else if(command==='/pause'){
            run.previous=['awaiting_input','paused','interrupted','failed'].includes(run.status)?run.previous??'implementing':run.status;
            run.status='paused';run.blocker='Telegram pause recorded';this.store.save(run);
            effect=()=>this.workflow.stop(run,'paused');outcome='Pause saved; local resume required.';
          }else if(command==='/status')outcome=this.summary(run);
          else throw new Error('Supported: /answer, /changes, /steer, /status, /pause. Approvals remain local.');
        }
        }
      }catch(e){
        if((e as NodeJS.ErrnoException).code)throw e;
        outcome=`Rejected: ${clean((e as Error).message).slice(0,1000)}`;
      }
      this.store.db.prepare('INSERT INTO telegram_updates VALUES(?,?)').run(envelope.update_id,outcome);
      const offset=Math.max(Number(this.store.setting('telegram-offset')??0),envelope.update_id+1);
      this.store.setSetting('telegram-offset',String(offset));
    });
    // Inputs and deduplication commit before touching a live session or advancing polling.
    if(effect){try{await effect();}catch{outcome+=' Use the local commands to continue; the input remains saved.';}}
    if(callback){try{await this.api('answerCallbackQuery',{callback_query_id:callback,text:outcome.slice(0,180)});}catch{/* local state is authoritative */}}
    return outcome;
  }
  private async sendNotice(run:Run,request:string|null,force=false):Promise<void>{
    if(['cancelled','ready_for_manual_merge'].includes(run.status))throw new Error('Cannot notify a terminal run');
    const id=request??`${run.id}-${run.status}-${context(run)}`;const key=`telegram-notice:${id}`;
    if(!force&&this.store.setting(key))return;
    const question=request?this.store.requests(run.id).find(q=>q.id===request&&q.pending&&q.context===(run.candidate?.hash??run.planHash??run.source)):undefined;
    if(request&&!question)throw new Error('Current pending request required');
    // Best effort, no outbox: uncertain sends require explicit resend, not automatic replay.
    this.store.setSetting(key,'attempted');
    const text=question?`${run.id} ${question.id}: ${question.question}\n/answer ${run.id} ${question.id} <answer>\nOr reply to this message.`:
      `${this.summary(run)}\n${run.status==='awaiting_merge_approval'?`Reply with review comments, or /changes ${run.id} ${run.candidate!.hash} <comments>.`:'Inspect and approve the plan locally in Herdr.'}`;
    const result=z.object({message_id:integer,chat}).parse(await this.api('sendMessage',{chat_id:this.config.chatId,
      text:clean(text).slice(0,4000),reply_markup:{inline_keyboard:[[{text:'Pause',callback_data:`pause:${run.id}`}]]}}));
    if(result.chat.id!==this.config.chatId)throw new Error('Telegram returned another chat');
    this.store.db.prepare('INSERT OR REPLACE INTO telegram_messages VALUES(?,?,?,?)').run(result.message_id,run.id,context(run),request);
    this.store.setSetting(key,'sent');
  }
  async resend(run:Run,request?:string):Promise<void>{await this.sendNotice(run,request??null,true);}
  private async notices():Promise<void>{
    for(const run of this.store.all()){
      if(['cancelled','ready_for_manual_merge'].includes(run.status))continue;
      if(['awaiting_input','paused','interrupted','failed'].includes(run.status)){
        for(const question of this.store.requests(run.id).filter(q=>q.pending&&q.context===(run.candidate?.hash??run.planHash??run.source)))await this.sendNotice(run,question.id);
      }
      if(['awaiting_plan_approval','awaiting_merge_approval'].includes(run.status))await this.sendNotice(run,null);
    }
  }
  private async loop():Promise<void>{
    let backoff=1000;
    while(!this.controller.signal.aborted){
      try{
        await this.notices();
        const updates=z.array(z.unknown()).max(100).parse(await this.api('getUpdates',{offset:Number(this.store.setting('telegram-offset')??0),
          timeout:5,limit:100,allowed_updates:['message','callback_query']}));
        for(const update of updates){
          if(this.controller.signal.aborted)break;
          const outcome=await this.receive(update);
          if(!['ignored','duplicate'].includes(outcome))await this.api('sendMessage',{chat_id:this.config.chatId,text:clean(outcome).slice(0,4000)}).catch(()=>undefined);
        }
        backoff=1000;
      }catch{if(!this.controller.signal.aborted)console.error('Telegram unavailable; questions remain visible locally.');}
      try{await delay(backoff,undefined,{signal:this.controller.signal});}catch{/* stop */}
      backoff=Math.min(backoff*2,30000);
    }
  }
}
