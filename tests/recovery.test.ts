import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureConfig, fixtureRun, issue } from './fixtures.js';
import { Store } from '../src/storage.js';
import { Workflow } from '../src/workflow.js';
import { Linear } from '../src/linear.js';
import { Workspace, stopRecordedWorkspaces } from '../src/host.js';
import { privateDirectory, hostEnvironment, command } from '../src/safety.js';
import { git } from '../src/git.js';
import { ROOT } from '../src/config.js';

async function until(predicate:()=>boolean,timeoutMs=60000):Promise<void> {
  const end=Date.now()+timeoutMs;
  while(!predicate()){if(Date.now()>end)throw new Error('Fixture state wait timed out');await new Promise(resolve=>setTimeout(resolve,50));}
}
async function fixtureRepository(root:string,check='print("baseline")\n'):Promise<string>{
  const repository=join(root,'target');await privateDirectory(repository);await privateDirectory(join(root,'.factory'));
  await git(repository,['init','--initial-branch=main','--quiet']);
  await writeFile(join(repository,'value.txt'),'old\n');await writeFile(join(repository,'check.py'),check);
  await git(repository,['add','value.txt','check.py']);await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','base']);
  return repository;
}
const alive=(pid:number):boolean=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('a pause during workspace deletion or candidate export cannot advance or promote partial evidence across restart',{timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-pause-cleanup-'));const repository=await fixtureRepository(root);
  const config=fixtureConfig(repository);const owner=`fixture-pause-${crypto.randomUUID()}`;
  let store=new Store(join(root,'.factory'));const linear=new Linear(config,root);linear.issue=async()=>issue;
  let deleted=false;let first=true;let release!:()=>void;
  const delayed=new Promise<void>(resolve=>{release=resolve;});
  let exported=false;let releaseExport!:()=>void;
  const delayedExport=new Promise<void>(resolve=>{releaseExport=resolve;});
  const agent:ConstructorParameters<typeof Workflow>[5]=async(role,workspace)=>{
    if(role==='implementer'){
      await workspace.write('value.txt','new\n');const exportSource=workspace.export.bind(workspace);
      workspace.export=async(directory)=>{const snapshot=await exportSource(directory);exported=true;await delayedExport;return snapshot;};
      return 'Completed fixture change';
    }
    if(first){
      first=false;const close=workspace.close.bind(workspace);let closing:Promise<void>|undefined;
      workspace.close=()=>closing??=(async()=>{await close();deleted=true;await delayed;})();
    }
    return JSON.stringify({summary:'Change value',paths:['value.txt'],acceptance:['new value'],steps:['Write new value']});
  };
  let workflow=new Workflow(config,store,linear,owner,root,agent);
  try{
    let run=await workflow.plan('ENG-42');await until(()=>deleted||run.status==='failed');
    assert.equal(deleted,true,run.blocker??'Expected completion of actual workspace deletion');
    const stopped=workflow.stop(run,'paused');assert.equal(store.get(run.id).status,'paused');release();await stopped;
    assert.equal(run.status,'paused','Finishing an asynchronous close must not overwrite human stop intent');
    assert.equal(store.unresolvedWorkspaces().length,0);assert.equal(store.approved(run),false);
    store.close();store=new Store(join(root,'.factory'));store.interrupt();run=store.get(run.id);assert.equal(run.status,'paused');
    workflow=new Workflow(config,store,linear,owner,root,agent);
    await workflow.resume(run);await workflow.active?.done;assert.equal(run.status,'awaiting_plan_approval');
    assert.equal(store.approved(run),false,'Explicit resume produces a plan gate, never implementation');
    await workflow.approve(run,'plan',run.planHash!);await until(()=>exported||run.status==='failed');
    assert.equal(exported,true,run.blocker??'Expected actual candidate export');
    const paused=workflow.stop(run,'paused');releaseExport();await paused;
    assert.equal(run.status,'paused');assert.equal(run.candidate,undefined,'Late export must not promote a candidate after pause');
    store.close();store=new Store(join(root,'.factory'));store.interrupt();run=store.get(run.id);
    assert.equal(run.status,'paused');assert.equal(run.candidate,undefined);assert.equal(store.unresolvedWorkspaces().length,0);
  }finally{release();releaseExport();if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});
test('a required check timeout records unavailable and skipped evidence durably without asking an agent to guess',{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-check-unavailable-'));const repository=await fixtureRepository(root);
  const config=fixtureConfig(repository);
  config.environment.checks=[{name:'timeout',argv:['python3','-I','-S','-c','import time;time.sleep(100)'],timeoutSeconds:1,required:true},
    {name:'not-run',argv:['python3','-I','-S','-c','print("must not execute after loss of the workspace")'],timeoutSeconds:10,required:true}];
  const store=new Store(join(root,'.factory'));const linear=new Linear(config,root);linear.issue=async()=>issue;let askedAgent=false;
  const workflow=new Workflow(config,store,linear,`fixture-unavailable-${crypto.randomUUID()}`,root,async()=>{askedAgent=true;throw new Error('No guessing');});
  try{
    const run=await workflow.plan('ENG-42');await workflow.active?.done;
    assert.equal(run.status,'failed');assert.equal(askedAgent,false);
    const saved=store.get(run.id);assert.deepEqual(saved.baseline.map(c=>c.outcome),['unavailable','skipped']);
    assert.match(await readFile(saved.baseline[0]!.log,'utf8'),/timed out/);
    assert.match(await readFile(saved.baseline[1]!.log,'utf8'),/Not run/);
    assert.equal(store.unresolvedWorkspaces().length,0);assert.equal(saved.plan,undefined);
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});
test('a required check for another platform cannot run here or pass through a baseline exception',{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-platform-'));const repository=await fixtureRepository(root);
  const config=fixtureConfig(repository);
  config.environment.checks=[{name:'linux acceptance',platform:'linux-x64',argv:['python3','-I','-S','-c','raise SystemExit(1)'],
    timeoutSeconds:10,required:true,acceptBaselineFailure:{reason:'This exception must not waive an unavailable platform'}}];
  const store=new Store(join(root,'.factory'));const linear=new Linear(config,root);linear.issue=async()=>issue;let called=false;
  const workflow=new Workflow(config,store,linear,`fixture-platform-${crypto.randomUUID()}`,root,async()=>{called=true;throw new Error('No guessing');});
  try{
    const run=await workflow.plan('ENG-42');await workflow.active?.done;
    assert.equal(run.status,'failed');assert.equal(called,false);assert.equal(run.baseline[0]!.outcome,'unavailable');
    assert.equal(run.baseline[0]!.code,null,'The unsupported command was not executed');
    assert.match(await readFile(run.baseline[0]!.log,'utf8'),/requires linux-x64/);
    assert.equal(store.unresolvedWorkspaces().length,0);assert.equal(run.plan,undefined);
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});
test('pause and cancel intent survive SIGKILL during blocked cleanup of sandboxed execution',{timeout:120000},async()=>{
  for(const status of ['paused','cancelled'] as const){
    const root=await mkdtemp(join(tmpdir(),'factory-stop-intent-'));await privateDirectory(root);await privateDirectory(join(root,'.factory'));
    const config=fixtureConfig('/tmp');const run=fixtureRun(config);const owner=`fixture-stop-${crypto.randomUUID()}`;
    const moduleUrl=(name:string)=>JSON.stringify(pathToFileURL(join(ROOT,`dist/src/${name}.js`)).href);
    const code=`import {Store} from ${moduleUrl('storage')};import {Workspace} from ${moduleUrl('host')};
      import {Workflow} from ${moduleUrl('workflow')};import {Linear} from ${moduleUrl('linear')};import {readFile} from 'node:fs/promises';
      const store=new Store(${JSON.stringify(join(root,'.factory'))});const run=${JSON.stringify(run)};const config=${JSON.stringify(config)};
      const owner=${JSON.stringify(owner)};store.create(run);store.intent(run,'execution intent');
      const workspace=await Workspace.create(config,owner,run.id,store,${JSON.stringify(root)});
      void workspace.execute(['sh','-c','sleep 100 & wait']).catch(()=>{});
      await new Promise(r=>setTimeout(r,500));
      // Inject a stuck deletion boundary while leaving actual execution present.
      workspace.close=async()=>{console.log('CLEANUP_WAIT '+workspace.dir+' '+await readFile(workspace.dir+'/pids.json','utf8'));await new Promise(()=>{});};
      const workflow=new Workflow(config,store,new Linear(config),owner,${JSON.stringify(root)});
      workflow.active={run,guest:workspace,controller:new AbortController(),done:new Promise(()=>{})};
      void workflow.stop(run,${JSON.stringify(status)}).catch(()=>{});console.log('STOP_PERSISTED '+store.get(run.id).status);
      setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...hostEnvironment(),PATH:process.env.PATH??''},stdio:['ignore','pipe','pipe']});
    let output='';let error='';child.stdout.on('data',data=>{output+=data.toString();});child.stderr.on('data',data=>{error+=data.toString();});
    try{
      await until(()=>output.includes('STOP_PERSISTED ')||child.exitCode!==null||child.signalCode!==null);
      assert.match(output,new RegExp('STOP_PERSISTED '+status),error);assert.match(output,/CLEANUP_WAIT/);
      const [,dir,pids]=/CLEANUP_WAIT (\S+) (\[.*\])/.exec(output)!;
      const recorded=(JSON.parse(pids!) as {pid:number}[]).map(p=>p.pid);assert.ok(recorded.length,'The running sandboxed command was recorded');
      assert.ok(recorded.every(alive),'Execution was present before the crash');
      child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
      const store=new Store(join(root,'.factory'));
      try{
        store.interrupt();assert.equal(store.get(run.id).status,status,'Recovery must preserve the durable human stop intent');
        await stopRecordedWorkspaces(store,owner);assert.equal(store.unresolvedWorkspaces().length,0);
        assert.equal(existsSync(dir!),false,'Recovery removes the recorded workspace');
        await until(()=>recorded.every(pid=>!alive(pid)),10000);
      }finally{store.close();}
    }finally{
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
      await rm(root,{recursive:true,force:true});
    }
  }
});
test('a pending question survives pause/restart; an answer cannot resume it and explicit resume uses a fresh workspace', {timeout:180000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-question-'));
  const repository=await fixtureRepository(root,'from pathlib import Path\nassert Path("value.txt").read_text().strip() in ("old", "new")\n');
  const config=fixtureConfig(repository);config.limits.stageSeconds=30;
  const owner=`fixture-question-${crypto.randomUUID()}`;
  let store=new Store(join(root,'.factory'));store.setSetting('owner',owner);
  const linear=new Linear(config,root);linear.issue=async()=>issue;
  const workspaces:string[]=[];
  const agent:ConstructorParameters<typeof Workflow>[5]=async(role,workspace,run,_store,_sessions,_prompt,_signal,ask)=>{
    workspaces.push(workspace.dir);
    if(role==='planner')return JSON.stringify({summary:'Change value',paths:['value.txt'],acceptance:['new value'],steps:['Write new value']});
    if(role==='implementer'){
      const saved=run.messages.find(m=>m.kind==='answer');
      const answer=saved?.text??await ask('Should the value be new?');
      if(answer!=='new')throw new Error('Unexpected fixture answer');
      await workspace.write('value.txt','new\n');return 'Done';
    }
    return JSON.stringify({findings:[],acceptance:[{criterion:'new value',passed:(await workspace.read('value.txt')).trim()==='new',evidence:'Read frozen value.txt'}]});
  };
  let workflow=new Workflow(config,store,linear,owner,root,agent);
  try{
    let run=await workflow.plan('ENG-42');await workflow.active?.done;
    await workflow.approve(run,'plan',run.planHash!);
    await until(()=>run.status==='awaiting_input'||run.status==='failed');
    assert.equal(run.status,'awaiting_input',run.blocker??'Question required');
    const request=store.requests(run.id)[0]!;
    const waiting=workflow.active!.guest!.dir;
    // Waiting for a person must outlast the stage's active-time limit without
    // aborting the session or consuming the saved run's active-time allowance.
    await new Promise(resolve=>setTimeout(resolve,31000));
    assert.equal(run.status,'awaiting_input');assert.equal(workflow.active?.controller.signal.aborted,false);
    const other={...fixtureRun(config),id:'F-1123456789ab',issue:{...issue,id:'9a0e0000-0000-4000-8000-000000000002'}};
    assert.throws(()=>store.create(other),/execution slot/);
    await workflow.stop(run,'paused');assert.equal(run.status,'paused');assert.equal(store.requests(run.id)[0]!.pending,true);
    assert.equal(existsSync(waiting),false,'Pause deletes the waiting workspace');
    store.close();store=new Store(join(root,'.factory'));store.interrupt();await stopRecordedWorkspaces(store,owner);
    workflow=new Workflow(config,store,linear,owner,root,agent);run=store.get(run.id);
    assert.equal(run.status,'paused');await assert.rejects(workflow.resume(run),/pending question/);
    workflow.answer(run,request.id,'new');assert.equal(run.status,'paused');assert.equal(workflow.active,undefined);
    await workflow.resume(run);await (workflow as Workflow).active?.done;
    assert.equal(run.status,'awaiting_merge_approval',run.blocker??'Resume should finish');
    assert.ok(workspaces.some(dir=>dir!==waiting));
    await workflow.stop(run,'cancelled');assert.equal(run.status,'cancelled');
    await assert.rejects(workflow.resume(run),/cannot resume/);
    assert.throws(()=>workflow.answer(run,request.id,'late'),/Obsolete/);
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});

test('SIGKILL leaves stage intent interrupted; recorded owned execution is confirmed stopped before recovery', {timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-crash-'));await privateDirectory(root);await privateDirectory(join(root,'.factory'));
  const config=fixtureConfig('/tmp');const run=fixtureRun(config);const owner=`fixture-crash-${crypto.randomUUID()}`;
  const moduleUrl=(name:string)=>JSON.stringify(pathToFileURL(join(ROOT,`dist/src/${name}.js`)).href);
  const code=`import {Store} from ${moduleUrl('storage')};import {Workspace} from ${moduleUrl('host')};import {lock} from ${moduleUrl('lock')};
    await lock(${JSON.stringify(join(root,'.factory'))});const store=new Store(${JSON.stringify(join(root,'.factory'))});store.setSetting('owner',${JSON.stringify(owner)});
    const run=${JSON.stringify(run)};store.create(run);store.intent(run,'saved-before-execution');
    const workspace=await Workspace.create(${JSON.stringify(config)},${JSON.stringify(owner)},run.id,store,${JSON.stringify(root)});
    void workspace.execute(['sh','-c','sleep 100 & wait']).catch(()=>{});
    await new Promise(r=>setTimeout(r,500));
    console.log('WORKSPACE_READY '+workspace.dir);setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...hostEnvironment(),PATH:process.env.PATH??''},stdio:['ignore','pipe','pipe']});
  let output='';let error='';child.stdout.on('data',data=>{output+=data.toString();});child.stderr.on('data',data=>{error+=data.toString();});
  try{
    await until(()=>output.includes('WORKSPACE_READY ')||child.exitCode!==null||child.signalCode!==null);
    assert.match(output,/WORKSPACE_READY /,error);
    const dir=/WORKSPACE_READY (\S+)/.exec(output)![1]!;
    const recorded=(JSON.parse(await readFile(join(dir,'pids.json'),'utf8')) as {pid:number}[]).map(p=>p.pid);
    child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    const store=new Store(join(root,'.factory'));
    try{
      store.interrupt();assert.equal(store.get(run.id).status,'interrupted');
      assert.equal(store.db.prepare('SELECT finished FROM stages WHERE run=?').get(run.id)?.finished,null);
      await stopRecordedWorkspaces(store,owner);assert.equal(store.unresolvedWorkspaces().length,0);
      assert.equal(existsSync(dir),false);
      await until(()=>recorded.every(pid=>!alive(pid)),10000);
    }finally{store.close();}
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}await rm(root,{recursive:true,force:true});}
});

test('sandboxed command output overflow stops the whole workspace without a successful result', {timeout:90000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-output-'));await privateDirectory(join(root,'.factory'));
  const config=fixtureConfig('/tmp');config.limits.maxOutputBytes=1024;
  const owner=`fixture-output-${crypto.randomUUID()}`;const workspace=await Workspace.create(config,owner,'output',undefined,root);
  try{
    await assert.rejects(workspace.execute(['python3','-I','-S','-c','import sys;sys.stdout.write("x"*100000)']),/output limit/);
    assert.equal(existsSync(workspace.dir),false);
    await assert.rejects(workspace.execute(['echo','later']),/stopped/);
  }finally{await workspace.close();await rm(root,{recursive:true,force:true});}
});

test('sandboxed command timeout stops the workspace and its background descendants', {timeout:90000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-timeout-'));await privateDirectory(join(root,'.factory'));
  const config=fixtureConfig('/tmp');const owner=`fixture-timeout-${crypto.randomUUID()}`;
  const workspace=await Workspace.create(config,owner,'timeout',undefined,root);
  const marker=`61.${Date.now()%100000}`;
  try{
    await assert.rejects(workspace.execute(['sh','-c',`sleep ${marker} & wait`],{timeout:1}),/timed out/i);
    assert.equal(existsSync(workspace.dir),false);
    await assert.rejects(workspace.execute(['echo','later']),/stopped/);
    const deadline=Date.now()+10000;
    while((await command(['/usr/bin/pgrep','-f',`sleep ${marker}`])).code===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    assert.notEqual((await command(['/usr/bin/pgrep','-f',`sleep ${marker}`])).code,0,'Background descendants of a timed-out command must be gone');
  }finally{await workspace.close();await rm(root,{recursive:true,force:true});}
});
