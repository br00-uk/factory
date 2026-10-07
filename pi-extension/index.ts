import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseCommand, send } from '../src/control.js';
import { ROOT } from '../src/config.js';
import { clean } from '../src/safety.js';

export default function factory(pi:ExtensionAPI):void {
  let timer:ReturnType<typeof setInterval>|undefined;
  let reading=false;const seen=new Map<string,string>();
  pi.registerCommand('factory',{description:'Factory commands and human approval gates',handler:async(args,ctx)=>{
    try {
      const result=await send(parseCommand(args.trim().split(/\s+/).filter(Boolean)),ROOT);
      pi.sendMessage({customType:'factory-result',content:clean(JSON.stringify(result,null,2)),display:true});
    }catch(e){ctx.ui.notify(clean((e as Error).message),'error');}
  }});
  pi.on('session_start',(_event,ctx)=>{
    ctx.ui.setStatus('factory','Factory /factory status · /factory plan ENG-123');
    if(pi.getActiveTools().length)throw new Error('Factory operator profile must have no model tools');
    const refresh=async()=>{
      if(reading)return;reading=true;
      try{
        const runs=await send({command:'status'},ROOT) as {id:string;status:string;requests:{id:string;question:string}[]}[];
        ctx.ui.setStatus('factory',clean(`Factory /factory status · ${runs.map(r=>`${r.id} ${r.status}`).join(' · ')||'/factory plan ENG-123'}`));
        for(const run of runs){
          const state=JSON.stringify({status:run.status,requests:run.requests.map(q=>q.id)});
          if(seen.get(run.id)!==state){
            seen.set(run.id,state);
            if(['awaiting_plan_approval','awaiting_merge_approval','awaiting_input','failed','interrupted','paused'].includes(run.status)){
              const detail=await send({command:'status',run:run.id},ROOT);
              pi.sendMessage({customType:'factory-event',content:clean(JSON.stringify(detail,null,2)),display:true});
            }
          }
        }
      }catch{/* Supervisor availability is shown by explicit /factory commands. */}
      finally{reading=false;}
    };
    timer=setInterval(()=>{void refresh();},2000);void refresh();
  });
  pi.on('session_shutdown',()=>{if(timer)clearInterval(timer);});
  pi.on('user_bash',()=>({result:{output:'Host shell execution is unavailable in the factory profile.',exitCode:1,cancelled:false,truncated:false}}));
  pi.on('input',(_event,ctx)=>{
    ctx.ui.notify('Use /factory commands. Agent conversations execute in the supervisor’s VM sessions.','info');
    return {action:'handled' as const};
  });
  pi.on('before_provider_request',()=>{throw new Error('Operator profile cannot start model requests; use /factory commands');});
}
