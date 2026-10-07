import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { doctor } from './doctor.js';
import { paths, credentialEnvs, configHash } from './config.js';
import { atomicWrite, command, fingerprint, hostEnvironment, requireSuccess } from './safety.js';
import { send } from './control.js';
import { lock } from './lock.js';
import { Store } from './storage.js';
import { stopRecordedVMs } from './smol.js';
import { Linear } from './linear.js';

interface Workspace {id:string;label:string;supervisor:string;linear:string;operator:string;socket:string}
class UnconfirmedSupervisor extends Error {}
const quote=(value:string):string=>`'${value.replaceAll("'", "'\\''")}'`;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function herdr(root:string,args:string[],socket?:string):Promise<any> {
  if(process.env.HERDR_ENV!=='1')throw new Error('Run make up inside Herdr (HERDR_ENV=1); the factory does not control a focused session from outside it');
  const env=hostEnvironment({HERDR_ENV:'1',...(socket??process.env.HERDR_SOCKET_PATH?{HERDR_SOCKET_PATH:socket??process.env.HERDR_SOCKET_PATH!}:{})});
  const output=requireSuccess(await command([join(paths(root).tools,'herdr'),...args],{env,timeoutMs:30_000})).toString();
  if(!output.trim()){
    if((args[0]==='pane'&&['run','close'].includes(args[1]??''))||(args[0]==='workspace'&&args[1]==='close'))return undefined;
    throw new Error(`Herdr ${args.slice(0,2).join(' ')} returned no structured result`);
  }
  try{return JSON.parse(output).result;}
  catch{throw new Error(`Herdr ${args.slice(0,2).join(' ')} returned invalid JSON`);}
}
async function record(root:string):Promise<Workspace|undefined> {
  try{return JSON.parse(await readFile(join(paths(root).state,'workspace.json'),'utf8')) as Workspace;}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
}
async function operatorReady(root:string,workspace:Workspace):Promise<void>{
  const deadline=Date.now()+10000;let failure='Owned operator pane is not running the factory Pi profile';
  while(Date.now()<deadline){
    try{
      const result=await herdr(root,['agent','get',workspace.operator],workspace.socket);
      if(result.agent?.agent==='pi'&&result.agent?.terminal_title_stripped?.includes('Factory'))return;
    }catch(e){failure=(e as Error).message;}
    await sleep(100);
  }
  throw new Error(`Factory operator readiness failed: ${failure}`);
}
async function closeOwned(root:string,workspace:Workspace):Promise<void>{
  const result=await herdr(root,['pane','list','--workspace',workspace.id],workspace.socket);
  const panes=result.panes as {pane_id:string}[];
  const owned=new Set([workspace.supervisor,workspace.linear,workspace.operator].filter(Boolean));
  if(panes.every(p=>owned.has(p.pane_id)))await herdr(root,['workspace','close',workspace.id],workspace.socket);
  else for(const pane of panes.filter(p=>owned.has(p.pane_id)))await herdr(root,['pane','close',pane.pane_id],workspace.socket);
}
async function stopSupervisor(root:string):Promise<void>{
  const p=paths(root);
  try{await send({command:'shutdown'},root);}catch{/* confirm absence using the OS lock */}
  let unlock:(()=>Promise<void>)|undefined;
  for(let n=0;n<100;n++){try{unlock=await lock(p.state);break;}catch{await sleep(100);}}
  if(!unlock)throw new Error('Supervisor still owns its lock; termination unconfirmed');
  try {
    const store=new Store(p.state);
    try{store.interrupt();const owner=store.setting('owner');if(owner)await stopRecordedVMs(store,owner);}finally{store.close();}
  }finally{await unlock();}
}
async function supervisorReady(root:string,workspace:Workspace,expectedConfig:string):Promise<void>{
  let health:{root:string;pane:string|null;configHash:string};
  try{health=await send({command:'health'},root) as typeof health;}
  catch(e){throw new UnconfirmedSupervisor(`Supervisor ownership unavailable: ${(e as Error).message}`);}
  if(health.root!==root||health.pane!==workspace.supervisor)throw new UnconfirmedSupervisor('The ready supervisor does not belong to this workspace pane');
  if(health.configHash!==expectedConfig)throw new Error('Supervisor configuration changed; run make down then make up');
  const result=await herdr(root,['pane','list','--workspace',workspace.id],workspace.socket);
  if(!result.panes.some((pane:{pane_id:string})=>pane.pane_id===workspace.supervisor))throw new Error('Owned supervisor pane is missing or moved');
}
export async function up(root:string):Promise<void> {
  const p=paths(root);const launchUnlock=await lock(join(p.state,'launcher'));
  let created:Workspace|undefined;let handoff:string|undefined;let foreignSupervisor=false;
  try {
    const config=await doctor(root);const existing=await record(root);
    if(existing){
      const live=await herdr(root,['workspace','get',existing.id],existing.socket);
      if(live.workspace?.label!==existing.label)throw new Error('Stored workspace ownership cannot be confirmed');
      await supervisorReady(root,existing,configHash(config));
      await new Linear(config,root).ready();await operatorReady(root,existing);
      console.log(`Factory workspace ${existing.id} already ready. State: ${p.state}`);return;
    }
    // Refuse an unrecorded foreground supervisor before creating any new UI.
    const supervisorUnlock=await lock(p.state);await supervisorUnlock();
    const label=`Factory ${fingerprint(root).slice(0,8)}`;
    const result=await herdr(root,['workspace','create','--cwd',root,'--label',label,'--no-focus']);
    const id=result.workspace.workspace_id??result.workspace.id;
    const supervisor=result.root_pane.pane_id;
    if(typeof id!=='string'||typeof supervisor!=='string')throw new Error('Unsupported Herdr workspace creation response');
    created={id,label,supervisor,linear:'',operator:'',socket:process.env.HERDR_SOCKET_PATH!};
    await atomicWrite(join(p.state,'workspace.json'),JSON.stringify(created));
    const right=await herdr(root,['pane','split','--pane',supervisor,'--direction','right','--ratio','0.5','--cwd',config.repository,'--no-focus']);
    created.linear=right.pane.pane_id;
    const bottom=await herdr(root,['pane','split','--pane',supervisor,'--direction','down','--ratio','0.5','--cwd',root,'--no-focus']);
    created.operator=bottom.pane.pane_id;
    await atomicWrite(join(p.state,'workspace.json'),JSON.stringify(created));
    const nonce=crypto.randomUUID();handoff=join(p.state,`handoff-${nonce}.json`);
    const names=credentialEnvs(config);
    await atomicWrite(handoff,JSON.stringify(Object.fromEntries(names.map(name=>[name,process.env[name]]))));
    await herdr(root,['pane','run',supervisor,[process.execPath,join(root,'dist/src/cli.js'),'serve','--handoff',nonce].map(quote).join(' ')]);
    let ready=false;
    for(let n=0;n<100;n++){try{await send({command:'status'},root);ready=true;break;}catch{await sleep(100);}}
    if(!ready)throw new Error('Supervisor failed readiness; inspect its pane output');
    try{await supervisorReady(root,created,configHash(config));}catch(e){foreignSupervisor=e instanceof UnconfirmedSupervisor;throw e;}
    await herdr(root,['pane','run',created.linear,[process.execPath,join(root,'dist/src/cli.js'),'linear-ui'].map(quote).join(' ')]);
    await herdr(root,['pane','run',created.operator,[process.execPath,join(root,'dist/src/cli.js'),'operator-ui'].map(quote).join(' ')]);
    // Require actual pane output from both programs before reporting the workspace ready.
    await herdr(root,['pane','wait-output',created.operator,'--match','Factory /factory','--timeout','15000']);
    await operatorReady(root,created);
    let linearReady=false;let linearFailure='Linear view unavailable';
    for(let n=0;n<20;n++){
      try{await new Linear(config,root).ready();linearReady=true;break;}
      catch(e){linearFailure=(e as Error).message;await sleep(250);}
    }
    if(!linearReady)throw new Error(`Linear TUI readiness failed: ${linearFailure}`);
    console.log(`Factory ready in ${created.id}. State: ${p.state}. No run has started.`);
  }catch(e){
    if(created){
      try{
        if(!foreignSupervisor)await stopSupervisor(root);
        await closeOwned(root,created);
        await unlink(join(p.state,'workspace.json'));
      }catch(cleanup){throw new Error(`${(e as Error).message}. Startup cleanup unconfirmed: ${(cleanup as Error).message}. The workspace record is retained for make down.`);}
    }
    throw e;
  }finally{if(handoff)await unlink(handoff).catch(()=>undefined);await launchUnlock();}
}
export async function down(root:string):Promise<void> {
  const p=paths(root);const launcherUnlock=await lock(join(p.state,'launcher'));
  try {
    await stopSupervisor(root);
    const workspace=await record(root);
    if(workspace){
      const live=await herdr(root,['workspace','get',workspace.id],workspace.socket);
      if(live.workspace?.label!==workspace.label)throw new Error('Workspace ownership uncertain; refusing to close it');
      await closeOwned(root,workspace);
      await unlink(join(p.state,'workspace.json'));
    }
    console.log('Factory supervisor and recorded guest execution stopped. Saved state/evidence retained.');
  }finally{await launcherUnlock();}
}
