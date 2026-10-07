import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureConfig, fixtureRun, issue } from './fixtures.js';
import { Store } from '../src/storage.js';
import { Workflow } from '../src/workflow.js';
import { Linear } from '../src/linear.js';
import { Guest, stopRecordedVMs, LOCAL } from '../src/smol.js';
import { privateDirectory, hostEnvironment } from '../src/safety.js';
import { git } from '../src/git.js';
import { ROOT } from '../src/config.js';
import { Machine } from 'smolmachines';

async function until(predicate:()=>boolean,timeoutMs=60000):Promise<void> {
  const end=Date.now()+timeoutMs;
  while(!predicate()){if(Date.now()>end)throw new Error('Fixture state wait timed out');await new Promise(resolve=>setTimeout(resolve,50));}
}
test('a pause during real VM deletion or candidate export cannot advance or promote partial evidence across restart',{timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-pause-cleanup-'));const repository=join(root,'target');
  await privateDirectory(repository);await privateDirectory(join(root,'.factory'));
  await git(repository,['init','--initial-branch=main','--quiet']);
  await writeFile(join(repository,'value.txt'),'old\n');await writeFile(join(repository,'check.py'),'print("baseline")\n');
  await git(repository,['add','value.txt','check.py']);await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','base']);
  const config=fixtureConfig(repository);const owner=`fixture-pause-${crypto.randomUUID()}`;
  let store=new Store(join(root,'.factory'));const linear=new Linear(config,root);linear.issue=async()=>issue;
  let deleted=false;let first=true;let release!:()=>void;
  const delayed=new Promise<void>(resolve=>{release=resolve;});
  let exported=false;let releaseExport!:()=>void;
  const delayedExport=new Promise<void>(resolve=>{releaseExport=resolve;});
  const agent:ConstructorParameters<typeof Workflow>[5]=async(role,guest)=>{
    if(role==='implementer'){
      await guest.write('value.txt','new\n');const exportSource=guest.export.bind(guest);
      guest.export=async(directory)=>{const snapshot=await exportSource(directory);exported=true;await delayedExport;return snapshot;};
      return 'Completed fixture change';
    }
    if(first){
      first=false;const close=guest.close.bind(guest);let closing:Promise<void>|undefined;
      guest.close=()=>closing??=(async()=>{await close();deleted=true;await delayed;})();
    }
    return JSON.stringify({summary:'Change value',paths:['value.txt'],acceptance:['new value'],steps:['Write new value']});
  };
  let workflow=new Workflow(config,store,linear,owner,root,agent);
  try{
    let run=await workflow.plan('ENG-42');await until(()=>deleted||run.status==='failed');
    assert.equal(deleted,true,run.blocker??'Expected completion of actual guest deletion');
    const stopped=workflow.stop(run,'paused');assert.equal(store.get(run.id).status,'paused');release();await stopped;
    assert.equal(run.status,'paused','Finishing an asynchronous close must not overwrite human stop intent');
    assert.equal(store.unresolvedVMs().length,0);assert.equal(store.approved(run),false);
    store.close();store=new Store(join(root,'.factory'));store.interrupt();run=store.get(run.id);assert.equal(run.status,'paused');
    workflow=new Workflow(config,store,linear,owner,root,agent);
    await workflow.resume(run);await workflow.active?.done;assert.equal(run.status,'awaiting_plan_approval');
    assert.equal(store.approved(run),false,'Explicit resume produces a plan gate, never implementation');
    await workflow.approve(run,'plan',run.planHash!);await until(()=>exported||run.status==='failed');
    assert.equal(exported,true,run.blocker??'Expected actual candidate export');
    const paused=workflow.stop(run,'paused');releaseExport();await paused;
    assert.equal(run.status,'paused');assert.equal(run.candidate,undefined,'Late export must not promote a candidate after pause');
    store.close();store=new Store(join(root,'.factory'));store.interrupt();run=store.get(run.id);
    assert.equal(run.status,'paused');assert.equal(run.candidate,undefined);assert.equal(store.unresolvedVMs().length,0);
  }finally{release();releaseExport();if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});
test('a required check timeout records unavailable and skipped evidence durably without asking an agent to guess',{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-check-unavailable-'));const repository=join(root,'target');
  await privateDirectory(repository);await privateDirectory(join(root,'.factory'));
  await git(repository,['init','--initial-branch=main','--quiet']);await writeFile(join(repository,'value.txt'),'old\n');
  await git(repository,['add','value.txt']);await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','base']);
  const config=fixtureConfig(repository);
  config.environment.checks=[{name:'timeout',argv:['python3','-I','-S','-c','import time;time.sleep(100)'],timeoutSeconds:1,required:true},
    {name:'not-run',argv:['python3','-I','-S','-c','print("must not execute after loss of guest")'],timeoutSeconds:10,required:true}];
  const store=new Store(join(root,'.factory'));const linear=new Linear(config,root);linear.issue=async()=>issue;let askedAgent=false;
  const workflow=new Workflow(config,store,linear,`fixture-unavailable-${crypto.randomUUID()}`,root,async()=>{askedAgent=true;throw new Error('No guessing');});
  try{
    const run=await workflow.plan('ENG-42');await workflow.active?.done;
    assert.equal(run.status,'failed');assert.equal(askedAgent,false);
    const saved=store.get(run.id);assert.deepEqual(saved.baseline.map(c=>c.outcome),['unavailable','skipped']);
    assert.match(await readFile(saved.baseline[0]!.log,'utf8'),/timed out/);
    assert.match(await readFile(saved.baseline[1]!.log,'utf8'),/Not run/);
    assert.equal(store.unresolvedVMs().length,0);assert.equal(saved.plan,undefined);
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});
test('a required macOS check cannot run in Linux or pass through a baseline exception',{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-platform-'));const repository=join(root,'target');
  await privateDirectory(repository);await privateDirectory(join(root,'.factory'));
  await git(repository,['init','--initial-branch=main','--quiet']);await writeFile(join(repository,'value.txt'),'old\n');
  await git(repository,['add','value.txt']);await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','base']);
  const config=fixtureConfig(repository);
  config.environment.checks=[{name:'macOS acceptance',platform:'darwin-arm64',argv:['python3','-I','-S','-c','raise SystemExit(1)'],
    timeoutSeconds:10,required:true,acceptBaselineFailure:{reason:'This exception must not waive an unavailable platform'}}];
  const store=new Store(join(root,'.factory'));const linear=new Linear(config,root);linear.issue=async()=>issue;let called=false;
  const workflow=new Workflow(config,store,linear,`fixture-platform-${crypto.randomUUID()}`,root,async()=>{called=true;throw new Error('No guessing');});
  try{
    const run=await workflow.plan('ENG-42');await workflow.active?.done;
    assert.equal(run.status,'failed');assert.equal(called,false);assert.equal(run.baseline[0]!.outcome,'unavailable');
    assert.equal(run.baseline[0]!.code,null,'The unsupported command was not executed');
    assert.match(await readFile(run.baseline[0]!.log,'utf8'),/requires darwin-arm64/);
    assert.equal(store.unresolvedVMs().length,0);assert.equal(run.plan,undefined);
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});
test('pause and cancel intent survive SIGKILL during blocked cleanup of real guest execution',{timeout:120000},async()=>{
  for(const status of ['paused','cancelled'] as const){
    const root=await mkdtemp(join(tmpdir(),'factory-stop-intent-'));await privateDirectory(root);
    const config=fixtureConfig('/tmp');const run=fixtureRun(config);const owner=`fixture-stop-${crypto.randomUUID()}`;
    const moduleUrl=(name:string)=>JSON.stringify(pathToFileURL(join(ROOT,`dist/src/${name}.js`)).href);
    const code=`import {Store} from ${moduleUrl('storage')};import {Guest} from ${moduleUrl('smol')};
      import {Workflow} from ${moduleUrl('workflow')};import {Linear} from ${moduleUrl('linear')};
      const store=new Store(${JSON.stringify(root)});const run=${JSON.stringify(run)};const config=${JSON.stringify(config)};
      const owner=${JSON.stringify(owner)};store.create(run);store.intent(run,'execution intent');
      const guest=await Guest.create(config,owner,run.id,store);
      void guest.execute(['sh','-c','sleep 100 & wait']).catch(()=>{});
      // Inject a stuck deletion boundary while leaving actual execution present.
      guest.close=async()=>{console.log('CLEANUP_WAIT');await new Promise(()=>{});};
      const workflow=new Workflow(config,store,new Linear(config),owner,${JSON.stringify(root)});
      workflow.active={run,guest,controller:new AbortController(),done:new Promise(()=>{})};
      void workflow.stop(run,${JSON.stringify(status)}).catch(()=>{});console.log('STOP_PERSISTED '+store.get(run.id).status);
      setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{env:hostEnvironment(),stdio:['ignore','pipe','pipe']});
    let output='';let error='';child.stdout.on('data',data=>{output+=data.toString();});child.stderr.on('data',data=>{error+=data.toString();});
    try{
      await until(()=>output.includes('STOP_PERSISTED ')||child.exitCode!==null||child.signalCode!==null);
      assert.match(output,new RegExp('STOP_PERSISTED '+status),error);assert.match(output,/CLEANUP_WAIT/);
      child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
      const store=new Store(root);
      try{
        store.interrupt();assert.equal(store.get(run.id).status,status,'Recovery must preserve the durable human stop intent');
        await stopRecordedVMs(store,owner);assert.equal(store.unresolvedVMs().length,0);
        assert.equal((await Machine.list(LOCAL)).some(m=>m.labels.owner===owner),false);
      }finally{store.close();}
    }finally{
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
      await rm(root,{recursive:true,force:true});
    }
  }
});
test('a pending question survives pause/restart; an answer cannot resume it and explicit resume uses a fresh VM', {timeout:180000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-question-'));const repository=join(root,'target');
  await privateDirectory(repository);await privateDirectory(join(root,'.factory'));
  await git(repository,['init','--initial-branch=main','--quiet']);
  await writeFile(join(repository,'value.txt'),'old\n');
  await writeFile(join(repository,'check.py'),'from pathlib import Path\nassert Path("value.txt").read_text().strip() in ("old", "new")\n');
  await git(repository,['add','value.txt','check.py']);
  await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','base']);
  const config=fixtureConfig(repository);config.limits.stageSeconds=30;
  const owner=`fixture-question-${crypto.randomUUID()}`;
  let store=new Store(join(root,'.factory'));store.setSetting('owner',owner);
  const linear=new Linear(config,root);linear.issue=async()=>issue;
  const guests:string[]=[];
  const agent:ConstructorParameters<typeof Workflow>[5]=async(role,guest,run,_store,_sessions,_prompt,_signal,ask)=>{
    guests.push(guest.machine.name);
    if(role==='planner')return JSON.stringify({summary:'Change value',paths:['value.txt'],acceptance:['new value'],steps:['Write new value']});
    if(role==='implementer'){
      const saved=run.messages.find(m=>m.kind==='answer');
      const answer=saved?.text??await ask('Should the value be new?');
      if(answer!=='new')throw new Error('Unexpected fixture answer');
      await guest.write('value.txt','new\n');return 'Done';
    }
    return JSON.stringify({findings:[],acceptance:[{criterion:'new value',passed:(await guest.read('value.txt')).trim()==='new',evidence:'Read frozen value.txt'}]});
  };
  let workflow=new Workflow(config,store,linear,owner,root,agent);
  try{
    let run=await workflow.plan('ENG-42');await workflow.active?.done;
    await workflow.approve(run,'plan',run.planHash!);
    await until(()=>run.status==='awaiting_input'||run.status==='failed');
    assert.equal(run.status,'awaiting_input',run.blocker??'Question required');
    const request=store.requests(run.id)[0]!;
    const waitingVM=workflow.active!.guest!.machine.name;
    // Waiting for a person must outlast the stage's active-time limit without
    // aborting the session or consuming the saved run's active-time allowance.
    await new Promise(resolve=>setTimeout(resolve,31000));
    assert.equal(run.status,'awaiting_input');assert.equal(workflow.active?.controller.signal.aborted,false);
    const other={...fixtureRun(config),id:'F-1123456789ab',issue:{...issue,id:'9a0e0000-0000-4000-8000-000000000002'}};
    assert.throws(()=>store.create(other),/execution slot/);
    await workflow.stop(run,'paused');assert.equal(run.status,'paused');assert.equal(store.requests(run.id)[0]!.pending,true);
    assert.equal((await Machine.list(LOCAL)).some(m=>m.name===waitingVM),false);
    store.close();store=new Store(join(root,'.factory'));store.interrupt();await stopRecordedVMs(store,owner);
    workflow=new Workflow(config,store,linear,owner,root,agent);run=store.get(run.id);
    assert.equal(run.status,'paused');await assert.rejects(workflow.resume(run),/pending question/);
    workflow.answer(run,request.id,'new');assert.equal(run.status,'paused');assert.equal(workflow.active,undefined);
    await workflow.resume(run);await (workflow as Workflow).active?.done;
    assert.equal(run.status,'awaiting_merge_approval',run.blocker??'Resume should finish');
    assert.ok(guests.some(name=>name!==waitingVM));
    await workflow.stop(run,'cancelled');assert.equal(run.status,'cancelled');
    await assert.rejects(workflow.resume(run),/cannot resume/);
    assert.throws(()=>workflow.answer(run,request.id,'late'),/Obsolete/);
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});

test('SIGKILL leaves stage intent interrupted; recorded owned execution is confirmed stopped before recovery', {timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-crash-'));await privateDirectory(root);
  const config=fixtureConfig('/tmp');const run=fixtureRun(config);const owner=`fixture-crash-${crypto.randomUUID()}`;
  const moduleUrl=(name:string)=>JSON.stringify(pathToFileURL(join(ROOT,`dist/src/${name}.js`)).href);
  const code=`import {Store} from ${moduleUrl('storage')};import {Guest} from ${moduleUrl('smol')};import {lock} from ${moduleUrl('lock')};
    await lock(${JSON.stringify(root)});const store=new Store(${JSON.stringify(root)});store.setSetting('owner',${JSON.stringify(owner)});
    const run=${JSON.stringify(run)};store.create(run);store.intent(run,'saved-before-execution');
    const guest=await Guest.create(${JSON.stringify(config)},${JSON.stringify(owner)},run.id,store);
    console.log('VM_READY '+guest.machine.name);setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:hostEnvironment(),stdio:['ignore','pipe','pipe']});
  let output='';let error='';child.stdout.on('data',data=>{output+=data.toString();});child.stderr.on('data',data=>{error+=data.toString();});
  try{
    await until(()=>output.includes('VM_READY ')||child.exitCode!==null||child.signalCode!==null);
    assert.match(output,/VM_READY /,error);
    child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    const store=new Store(root);
    try{
      store.interrupt();assert.equal(store.get(run.id).status,'interrupted');
      assert.equal(store.db.prepare('SELECT finished FROM stages WHERE run=?').get(run.id)?.finished,null);
      await stopRecordedVMs(store,owner);assert.equal(store.unresolvedVMs().length,0);
      assert.equal((await Machine.list(LOCAL)).some(m=>m.labels.owner===owner),false);
    }finally{store.close();}
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}await rm(root,{recursive:true,force:true});}
});

test('real guest output overflow stops the whole machine without a successful result', {timeout:90000},async()=>{
  const config=fixtureConfig('/tmp');config.limits.maxOutputBytes=1024;
  const owner=`fixture-output-${crypto.randomUUID()}`;const guest=await Guest.create(config,owner,'output');
  try{
    await assert.rejects(guest.execute(['python3','-I','-S','-c','import sys;sys.stdout.write("x"*100000)']),/output limit/);
    assert.equal((await Machine.list(LOCAL)).some(m=>m.labels.owner===owner),false);
    await assert.rejects(guest.execute(['echo','later']),/stopped/);
  }finally{await guest.close();}
});

test('real guest command timeout stops the VM and its background descendants', {timeout:90000},async()=>{
  const config=fixtureConfig('/tmp');const owner=`fixture-timeout-${crypto.randomUUID()}`;
  const guest=await Guest.create(config,owner,'timeout');
  try{
    await assert.rejects(guest.execute(['sh','-c','sleep 60 & wait'],{timeout:1}),/timeout|timed out|infrastructure|exit evidence/i);
    assert.equal((await Machine.list(LOCAL)).some(m=>m.labels.owner===owner),false);
    await assert.rejects(guest.execute(['echo','later']),/stopped/);
  }finally{await guest.close();}
});
