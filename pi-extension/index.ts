import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This file may be loaded through the ~/.pi/agent/extensions symlink that
// `factory install` creates, so the factory checkout is found from the real
// path and the built modules are imported from its dist/ directory.
const ROOT=join(dirname(realpathSync(fileURLToPath(import.meta.url))),'..');
type Control=typeof import('../src/control.js');type Safety=typeof import('../src/safety.js');
let modules:Promise<{send:Control['send'];parseCommand:Control['parseCommand'];clean:Safety['clean']}>|undefined;
const lib=()=>modules??=(async()=>{
  const [control,safety]=await Promise.all([
    import(pathToFileURL(join(ROOT,'dist/src/control.js')).href) as Promise<Control>,
    import(pathToFileURL(join(ROOT,'dist/src/safety.js')).href) as Promise<Safety>]);
  return {send:control.send,parseCommand:control.parseCommand,clean:safety.clean};
})();

// Two ways to load this extension:
//  - installed globally by `factory install` (a symlink under ~/.pi/agent/extensions):
//    any Pi session gets /factory-init and /factory, and keeps its own tools;
//  - the dedicated operator pane opened by `make up` inside Herdr (FACTORY_OPERATOR=1):
//    no model tools, no model requests, no host shell — commands only.
const operator=process.env.FACTORY_OPERATOR==='1';

function runCli(args:string[],onLine:(line:string)=>void):Promise<{code:number;output:string}> {
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[join(ROOT,'dist/src/cli.js'),...args],{cwd:ROOT,env:process.env,stdio:['ignore','pipe','pipe']});
    let output='';let pending='';
    const consume=(data:Buffer)=>{output+=data.toString();pending+=data.toString();const lines=pending.split('\n');pending=lines.pop()??'';for(const line of lines)if(line.trim())onLine(line);};
    child.stdout.on('data',consume);child.stderr.on('data',consume);
    child.on('error',e=>{output+=e.message;resolve({code:1,output});});
    child.on('close',code=>{if(pending.trim())onLine(pending);resolve({code:code??1,output});});
  });
}
export default function factory(pi:ExtensionAPI):void {
  let timer:ReturnType<typeof setInterval>|undefined;
  let reading=false;const seen=new Map<string,string>();
  pi.registerCommand('factory',{description:'Factory commands and human approval gates (plan, status, approve, revise, answer, steer, pause, resume, cancel)',handler:async(args,ctx)=>{
    const {send,parseCommand,clean}=await lib();
    try {
      const result=await send(parseCommand(args.trim().split(/\s+/).filter(Boolean)),ROOT);
      pi.sendMessage({customType:'factory-result',content:clean(JSON.stringify(result,null,2)),display:true});
    }catch(e){ctx.ui.notify(clean((e as Error).message)+(/ENOENT|ECONNREFUSED/.test((e as Error).message)?' — the supervisor is not running; use /factory-init or factory up':''),'error');}
  }});
  pi.registerCommand('factory-init',{description:'Register this repository with the local factory: detect its checks, verify the sandbox, run the checks once, start the supervisor',handler:async(args,ctx)=>{
    const words=args.trim().split(/\s+/).filter(Boolean);
    const flag=(name:string)=>{const i=words.indexOf(`--${name}`);return i>=0?words[i+1]:undefined;};
    const cliArgs=['init',ctx.cwd,'--json'];
    let org=flag('org');let team=flag('team');const model=flag('model');
    if(ctx.hasUI&&!team&&!words.includes('--project-name')){
      const choice=await ctx.ui.input('Linear team key for this repository (e.g. ENG); leave empty to keep the existing configuration','TEAM');
      if(choice?.trim())team=choice.trim().toUpperCase();
      if(team&&!org){const o=await ctx.ui.input('Linear organization URL key (linear.app/<key>)','your-organization');if(o?.trim())org=o.trim();}
    }
    if(org)cliArgs.push('--org',org);if(team)cliArgs.push('--team',team);if(model)cliArgs.push('--model',model);
    if(flag('project-name')&&flag('project-url'))cliArgs.push('--project-name',flag('project-name')!,'--project-url',flag('project-url')!);
    if(words.includes('--no-validate'))cliArgs.push('--no-validate');if(words.includes('--no-start'))cliArgs.push('--no-start');
    const {clean}=await lib();
    ctx.ui.setWorkingMessage?.('Factory init: detecting checks and proving the sandbox');
    ctx.ui.notify('Factory init started; this runs the repository checks once in the sandbox and may take a few minutes.','info');
    const {code,output}=await runCli(cliArgs,()=>undefined);
    ctx.ui.setWorkingMessage?.();
    let summary=output;
    try{
      const start=output.indexOf('{');const parsed=JSON.parse(output.slice(start)) as {repository:string;baseRef:string;checks:string[];validated:string;supervisor:string;warnings:string[];next:string[];log:string[]};
      summary=[`Factory registered ${parsed.repository} (base ${parsed.baseRef})`,`Checks: ${parsed.checks.join(', ')}`,`Validation: ${parsed.validated} · Supervisor: ${parsed.supervisor}`,
        ...parsed.warnings.map(w=>`Warning: ${w}`),`Next: ${parsed.next.join('  ·  ')}`,'',...parsed.log].join('\n');
    }catch{/* raw output already in summary */}
    pi.sendMessage({customType:'factory-init',content:clean(summary),display:true});
    ctx.ui.notify(code===0?'Factory ready. Plan an issue with /factory plan <ID>.':'Factory init reported a problem; see the message above.',code===0?'info':'error');
  }});
  pi.on('session_start',(_event,ctx)=>{
    if(operator){ctx.ui.setStatus('factory','Factory /factory status · /factory plan ENG-123');if(pi.getActiveTools().length)throw new Error('Factory operator profile must have no model tools');}
    const refresh=async()=>{
      if(reading)return;reading=true;
      try{
        const {send,clean}=await lib();
        const runs=await send({command:'status'},ROOT) as {id:string;status:string;requests:{id:string;question:string}[]}[];
        ctx.ui.setStatus('factory',clean(`Factory ${runs.map(r=>`${r.id} ${r.status}`).join(' · ')||'/factory plan ENG-123'}`));
        for(const run of runs){
          const state=JSON.stringify({status:run.status,requests:run.requests.map(q=>q.id)});
          if(seen.get(run.id)!==state){
            const first=!seen.has(run.id);seen.set(run.id,state);
            if(!first&&['awaiting_plan_approval','awaiting_merge_approval','awaiting_input','failed','interrupted','paused'].includes(run.status)){
              const detail=await send({command:'status',run:run.id},ROOT);
              pi.sendMessage({customType:'factory-event',content:clean(JSON.stringify(detail,null,2)),display:true});
            }
          }
        }
      }catch{if(!operator)ctx.ui.setStatus('factory',undefined);}
      finally{reading=false;}
    };
    timer=setInterval(()=>{void refresh();},2000);void refresh();
  });
  pi.on('session_shutdown',()=>{if(timer)clearInterval(timer);});
  if(operator){
    pi.on('user_bash',()=>({result:{output:'Host shell execution is unavailable in the factory profile.',exitCode:1,cancelled:false,truncated:false}}));
    pi.on('input',(_event,ctx)=>{
      ctx.ui.notify('Use /factory commands. Agent conversations execute in the supervisor’s sandboxed sessions.','info');
      return {action:'handled' as const};
    });
    pi.on('before_provider_request',()=>{throw new Error('Operator profile cannot start model requests; use /factory commands');});
  }
}
