import { createServer, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink, readFile } from 'node:fs/promises';
import { paths, loadConfig, configHash, type Config } from './config.js';
import { clean, privateDirectory } from './safety.js';
import { lock } from './lock.js';
import { Store } from './storage.js';
import { RequestSchema, type Request } from './models.js';
import { Linear } from './linear.js';
import { Workflow } from './workflow.js';
import { runAgent } from './pi.js';
import { stopRecordedVMs } from './smol.js';
import { cleanup } from './artifacts.js';
import { MAX_MESSAGE } from './control.js';
import { Telegram } from './telegram.js';

export async function serve(root: string, config:Config, agent = runAgent): Promise<void> {
  const p=paths(root);await privateDirectory(p.state);await privateDirectory(p.artifacts);await privateDirectory(p.sessions);
  const unlock=await lock(p.state);let store:Store;
  try{store=new Store(p.state);}catch(e){await unlock();throw e;}
  const owner=store.setting('owner')??crypto.randomUUID();store.setSetting('owner',owner);
  let server:Server|undefined;let shutdown=false;let ready=false;let workflow:Workflow|undefined;let telegram:Telegram|undefined;
  const sockets=new Set<Socket>();
  const close=async()=>{
    if(shutdown)return;shutdown=true;
    let failure:unknown;
    try {
      if(workflow)workflow.stopping=true;
      if(workflow?.active){
        const run=workflow.active.run;const waiting=run.status==='awaiting_input';
        await workflow.stop(run,waiting?'paused':'interrupted');
        if(waiting)store.transition(run,'awaiting_input');
      }
      await telegram?.stop();
      await stopRecordedVMs(store,owner);
    }catch(e){failure=e;}
    finally{
      await new Promise<void>(resolve=>{
        if(server)server.close(()=>resolve());else resolve();
        for(const socket of sockets)socket.destroy();
      });
      await unlink(p.socket).catch(()=>undefined);
      store.close();await unlock();
    }
    if(failure){
      console.error(clean(`Shutdown could not confirm guest cleanup: ${(failure as Error).message}. The foreground supervisor will exit; recovery must confirm the engine reaped its recorded VMs.`));
      // Terminate only this dedicated supervisor process. Non-detached guests are
      // tied to it; a later owner still verifies deletion before admitting work.
      process.exit(1);
    }
  };
  try {
    store.interrupt();await stopRecordedVMs(store,owner);
    workflow=new Workflow(config,store,new Linear(config,root),owner,root,agent,()=>loadConfig(root));
    if(config.telegram)telegram=new Telegram(config.telegram,store,workflow);
    try{const stat=await lstat(p.socket);if(!stat.isSocket())throw new Error('Control path is not a socket');await unlink(p.socket);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    let queue:Promise<unknown>=Promise.resolve();
    server=createServer({allowHalfOpen:true},socket=>{
      sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
      const chunks:Buffer[]=[];let bytes=0;socket.setTimeout(10_000,()=>socket.destroy());
      socket.on('error',()=>undefined);
      socket.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>MAX_MESSAGE)socket.destroy();else chunks.push(chunk);});
      socket.on('end',()=>{
        const operation=queue.then(async()=>{
          if(shutdown)throw new Error('Supervisor stopping');
          const request=RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
          if(!ready&&request.command!=='shutdown')throw new Error('Supervisor startup has not completed');
          const result=await handle(request,workflow!,store,telegram);
          const response=JSON.stringify({ok:true,result});
          if(Buffer.byteLength(response)>MAX_MESSAGE)throw new Error('Response bound exceeded');
          socket.end(response);
          if(request.command==='shutdown')setImmediate(()=>{void close().catch(e=>{console.error(clean((e as Error).message));process.exitCode=1;});});
        }).catch(e=>{socket.end(JSON.stringify({ok:false,error:clean((e as Error).message)}));});
        queue=operation;
      });
    });
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(p.socket,()=>resolve());});
    await chmod(p.socket,0o600);await telegram?.ready();telegram?.start();ready=true;console.log(`Factory ready: ${p.socket}`);
    for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void close().catch(e=>{console.error(clean((e as Error).message));process.exitCode=1;});});
  }catch(e){await close();throw e;}
}
async function handle(request:Request, workflow:Workflow, store:Store, telegram?:Telegram):Promise<unknown> {
  if(request.command==='shutdown')return {stopping:true};
  if(request.command==='health')return {root:workflow.root,pid:process.pid,pane:process.env.HERDR_PANE_ID??null,configHash:configHash(workflow.config)};
  if(request.command==='status'){
    if(!request.run)return store.all().map(run=>({id:run.id,issue:run.issue.identifier,title:run.issue.title,status:run.status,
      planHash:run.planHash,candidateHash:run.candidate?.hash,evidenceHash:run.candidate?.evidenceHash,
      blocker:run.blocker,progress:run.progress,activeSeconds:run.activeSeconds,reservedUsd:run.spentUsd,modelUsage:run.modelUsage,
      requests:store.requests(run.id).filter(q=>q.pending)}));
    const runs=request.run?[workflow.getRun(request.run)]:store.all();
    return Promise.all(runs.map(async run=>({...run,requests:store.requests(run.id),
      ...(run.candidate?{diff:clean((await readFile(run.candidate.diffPath,'utf8')).slice(0,64000)),
        diffTruncated:(await readFile(run.candidate.diffPath)).length>64000,
        integration:`Inspect ${run.candidate.diffPath}. To import manually: git fetch '${run.candidate.repository.replaceAll("'", "'\\''")}' ${run.candidate.commit}. Inspect git show FETCH_HEAD, then integrate on your chosen destination branch, for example with git cherry-pick FETCH_HEAD. Recheck the destination and handle publication/merge manually. No publication or merge has occurred.`}:{}),
      elapsedSeconds:Math.round((Date.now()-Date.parse(run.created))/1000)})));
  }
  if(request.command==='cleanup'){
    if(workflow.active)throw new Error('Cleanup requires stopped execution');
    const protectedHashes=store.artifactReferences();
    return {removed:await cleanup(paths(workflow.root).artifacts,protectedHashes)};
  }
  if(request.command==='plan'){
    if(!request.issue)throw new Error('Provide an issue ID, URL, or current');
    return workflow.plan(request.issue);
  }
  if(!request.run)throw new Error('Run ID required');const run=workflow.getRun(request.run);
  if(request.command==='resend'){
    if(!telegram)throw new Error('Telegram is not configured');await telegram.resend(run,request.request);return {resent:true};
  }
  if(request.command==='approve'){
    if(!request.gate || !request.hash)throw new Error('Approval gate and hash required');
    await workflow.approve(run,request.gate,request.hash);
  }else if(request.command==='pause' || request.command==='cancel')await workflow.stop(run,request.command==='pause'?'paused':'cancelled');
  else if(request.command==='resume')await workflow.resume(run);
  else if(request.command==='answer'){
    if(!request.request || !request.message)throw new Error('Request ID and answer required');workflow.answer(run,request.request,request.message);
  }else if(request.command==='steer' || request.command==='revise'){
    if(!request.message)throw new Error('Message required');await workflow[request.command](run,request.message);
  }
  return run;
}
