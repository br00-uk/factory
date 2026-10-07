import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import { Telegram } from '../src/telegram.js';
import { Workflow } from '../src/workflow.js';
import { Linear } from '../src/linear.js';
import { fixtureConfig, fixtureRun } from './fixtures.js';

const config={tokenEnv:'FACTORY_TEST_BOT_TOKEN',userId:100,chatId:101};
process.env[config.tokenEnv]='123456:fixture-token-never-sent';
const inbound=(id:number,text:string,extra:Record<string,unknown>={})=>({update_id:id,message:{message_id:id,
  from:{id:100,is_bot:false},chat:{id:101,type:'private'},text,...extra}});
async function fixture(fetcher:typeof fetch){
  const root=await mkdtemp(join(tmpdir(),'factory-telegram-'));const store=new Store(root);
  const factoryConfig=fixtureConfig('/tmp');const run=fixtureRun(factoryConfig);store.create(run);
  run.planHash='c'.repeat(64);run.status='awaiting_input';run.previous='implementing';store.save(run);
  const request={id:'Q-0123456789ab',run:run.id,stage:'implementing' as const,context:run.planHash,
    question:'Use the new value?',pending:true,created:new Date().toISOString()};store.request(request);
  const workflow=new Workflow(factoryConfig,store,new Linear(factoryConfig,root),'telegram-fixture',root);
  const telegram=new Telegram(config,store,workflow,fetcher);
  return {root,store,run,request,workflow,telegram};
}
const noNetwork:typeof fetch=async()=>{throw new Error('Network is forbidden in this fixture');};

test('Telegram authenticates numeric user/private chat, stores answers and offsets atomically, and never resumes or approves remotely',async()=>{
  const f=await fixture(noNetwork);
  try{
    assert.equal(await f.telegram.receive(inbound(1,`/answer ${f.run.id} ${f.request.id} bad`,{from:{id:999}})),'ignored');
    assert.equal(await f.telegram.receive(inbound(2,`/answer ${f.run.id} ${f.request.id} bad`,{chat:{id:101,type:'group'}})),'ignored');
    assert.equal(f.store.requests(f.run.id)[0]!.pending,true);
    const answer=inbound(3,`/answer ${f.run.id} ${f.request.id} new`);
    assert.match(await f.telegram.receive(answer),/Answer saved/);
    assert.equal(f.store.requests(f.run.id)[0]!.answer,'new');assert.equal(f.store.get(f.run.id).status,'awaiting_input');
    assert.equal(await f.telegram.receive(answer),'duplicate');assert.equal(f.store.get(f.run.id).messages.length,1);
    assert.equal(f.store.setting('telegram-offset'),'4');
    assert.match(await f.telegram.receive(inbound(4,`/approve ${f.run.id} ${f.run.planHash}`)),/Approvals remain local/);
    assert.equal(f.store.approved(f.store.get(f.run.id)),false);
    assert.match(await f.telegram.receive(inbound(5,`/answer ${f.run.id} ${f.request.id} obsolete`)),/Obsolete/);
    f.run.status='cancelled';f.store.save(f.run);
    assert.match(await f.telegram.receive(inbound(6,`/steer ${f.run.id} late`)),/terminal/);
  }finally{await f.telegram.stop();f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('bot reply/button references bind recorded context and reject obsolete or invented references',async()=>{
  const calls:{method:string;body:any}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const method=String(input).split('/').at(-1)!;calls.push({method,body:JSON.parse(String(init?.body))});
    return new Response(JSON.stringify({ok:true,result:method==='sendMessage'?{message_id:7,chat:{id:101,type:'private'}}:true}));
  };
  const f=await fixture(fetcher);
  try{
    await f.telegram.resend(f.store.get(f.run.id),f.request.id);
    assert.equal(calls[0]!.body.chat_id,101);
    assert.equal(calls[0]!.body.reply_markup.inline_keyboard[0][0].callback_data,`pause:${f.run.id}`);
    const callback={update_id:10,callback_query:{id:'button',from:{id:100},data:`pause:${f.run.id}`,
      message:{message_id:7,chat:{id:101,type:'private'}}}};
    assert.match(await f.telegram.receive(callback),/Pause saved/);
    assert.equal(f.store.get(f.run.id).status,'paused');assert.equal(f.store.get(f.run.id).previous,'implementing');
    assert.match(await f.telegram.receive(inbound(11,'new',{reply_to_message:{message_id:7}})),/Answer saved/);
    assert.equal(f.store.get(f.run.id).status,'paused');
    assert.match(await f.telegram.receive({...callback,update_id:12}),/Obsolete/);
    assert.match(await f.telegram.receive(inbound(13,'invented',{reply_to_message:{message_id:999}})),/Unknown bot message/);
  }finally{await f.telegram.stop();f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('uncertain notification sends stay local, errors redact tokens, and restart uses saved offset without replaying an instruction',async()=>{
  const offsets:number[]=[];let fail=true;let sent=0;
  const fetcher:typeof fetch=async(input,init)=>{
    const method=String(input).split('/').at(-1)!;const body=JSON.parse(String(init?.body));
    if(method==='sendMessage'){
      if(fail)throw new Error(`Secret URL ${String(input)}`);sent++;
      return new Response(JSON.stringify({ok:true,result:{message_id:sent,chat:{id:101,type:'private'}}}));
    }
    if(method==='getUpdates'){offsets.push(body.offset);return new Response(JSON.stringify({ok:true,result:[]}));}
    throw new Error('Unexpected fixture method');
  };
  const f=await fixture(fetcher);let restarted:Telegram|undefined;
  try{
    await assert.rejects(f.telegram.resend(f.store.get(f.run.id),f.request.id),error=>{
      assert.ok(error instanceof Error);assert.equal(error.message.includes(process.env[config.tokenEnv]!),false);return true;
    });
    assert.equal(f.store.requests(f.run.id)[0]!.pending,true);
    assert.equal(f.store.setting(`telegram-notice:${f.request.id}`),'attempted');
    await f.telegram.receive(inbound(30,`/steer ${f.run.id} preserve scope`));
    assert.equal(f.store.get(f.run.id).messages.length,1);
    fail=false;await f.telegram.resend(f.store.get(f.run.id),f.request.id);
    restarted=new Telegram(config,f.store,f.workflow,fetcher);restarted.start();
    const end=Date.now()+1000;while(!offsets.length&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(offsets,[31]);assert.equal(sent,1);
    assert.equal(await restarted.receive(inbound(30,`/steer ${f.run.id} preserve scope`)),'duplicate');
    assert.equal(f.store.get(f.run.id).messages.length,1);
  }finally{await restarted?.stop();await f.telegram.stop();f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test('configured bot readiness rejects a webhook instead of changing remote configuration',async()=>{
  const methods:string[]=[];
  const fetcher:typeof fetch=async(input)=>{
    const method=String(input).split('/').at(-1)!;methods.push(method);
    return new Response(JSON.stringify({ok:true,result:method==='getMe'?{id:1,is_bot:true}:{url:'https://existing.example/webhook'}}));
  };
  const f=await fixture(fetcher);
  try{await assert.rejects(f.telegram.ready(),/webhook/);assert.deepEqual(methods,['getMe','getWebhookInfo']);}
  finally{await f.telegram.stop();f.store.close();await rm(f.root,{recursive:true,force:true});}
});
