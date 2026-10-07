import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from 'smolmachines';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Guest, LOCAL, REGISTRIES } from '../src/smol.js';
import { storeSnapshot, readSnapshot } from '../src/artifacts.js';
import { sandboxTools, trustedLoader } from '../src/pi.js';
import { fixtureConfig, issue } from './fixtures.js';
import { privateDirectory, fingerprint } from '../src/safety.js';
import { Store } from '../src/storage.js';
import { Workflow } from '../src/workflow.js';
import { Linear } from '../src/linear.js';
import { git } from '../src/git.js';

test('real smol and Pi boundary: denied network, explicit tools, binary transfer, frozen source, and termination', {timeout:180000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-vm-'));const config=fixtureConfig('/tmp');
  config.environment.env={FACTORY_TEST_INPUT:'configured'};
  config.environment.dependencies={argv:['sh','-c','mkdir -p node_modules/package; echo dependency > node_modules/package/value; ln -s value node_modules/package/link; echo cache > /var/cache/factory/proof'],timeoutSeconds:10,allowHosts:[],paths:['node_modules']};
  const owner=`factory-test-${crypto.randomUUID()}`;let guest:Guest|undefined;
  try{
    const bootStarted=performance.now();
    guest=await Guest.create(config,owner,'compatibility');
    const startupMs=Math.round(performance.now()-bootStarted);
    const bytes=Buffer.from([0,255,128,13,10]);
    const source=await storeSnapshot(root,[{path:'bytes.bin',mode:'100644',data:bytes},
      {path:'.pi/extensions/evil.ts',mode:'100644',data:Buffer.from('throw new Error("UNTRUSTED_EXTENSION_LOADED")')}],config.limits);
    await guest.import(source);
    const forbidden=await storeSnapshot(root,[{path:'node_modules/tracked.js',mode:'100644',data:Buffer.from('tracked')}],config.limits);
    await assert.rejects(guest.import(forbidden),/overlap tracked source/);
    await guest.prepareDependencies();
    assert.deepEqual(await guest.machine.readFile('/workspace/bytes.bin'),bytes);
    const boundary=await guest.execute(['python3','-I','-S','-c',`import os,socket
assert os.getuid()==1000
assert os.environ.get('FACTORY_TEST_INPUT')=='configured'
assert os.path.isfile('/var/cache/factory/proof')
assert os.path.isfile('/workspace/.git/index')
assert not os.path.exists(${JSON.stringify(root)})
for host in ['1.1.1.1','127.0.0.1','192.168.1.1','100.96.0.1','::1','2606:4700:4700::1111']:
 try:
  s=socket.create_connection((host,443),timeout=0.4);s.close();raise RuntimeError('Unexpected connection '+host)
 except (OSError,TimeoutError): pass
for host in ['example.com','registry-1.docker.io']:
 try:
  s=socket.create_connection((host,443),timeout=0.4);s.close();raise RuntimeError('Unexpected hostname connection')
 except (OSError,TimeoutError): pass
print('denied')`]);
    assert.equal(boundary.code,0,boundary.stderr);
    const resources=await guest.execute(['python3','-I','-S','-c',`import os
assert os.cpu_count()==1
mem=int(next(line.split()[1] for line in open('/proc/meminfo') if line.startswith('MemTotal:')))
assert 256*1024<mem<=512*1024
disk=os.statvfs('/workspace')
assert disk.f_blocks*disk.f_frsize<=1024**3
print('resource bounds confirmed')`]);
    assert.equal(resources.code,0,resources.stderr);
    const loader=trustedLoader('implementer');assert.equal(loader.getExtensions().extensions.length,0);assert.equal(loader.getAgentsFiles().agentsFiles.length,0);
    const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
    const model=runtime.getModels()[0];assert.ok(model,'Pinned Pi has no static models');
    const tools=sandboxTools(guest,'implementer',async()=>{throw new Error('No human answer in compatibility test');});
    const {session}=await createAgentSession({cwd:root,agentDir:root,modelRuntime:runtime,model,
      tools:tools.map(t=>t.name),customTools:tools,resourceLoader:loader,sessionManager:SessionManager.inMemory(root),
      settingsManager:SettingsManager.inMemory({cacheWarming:'off'})});
    try{
      assert.deepEqual(session.getActiveToolNames().sort(),['ask_human','vm_exec','vm_list','vm_read','vm_search','vm_write']);
      assert.equal(session.getActiveToolNames().includes('bash'),false);
      // Exercise the actual registered SDK tool, without any paid provider request.
      const tool=session.getToolDefinition('vm_exec')!;
      const toolStarted=performance.now();
      const result=await tool.execute('test-call',{argv:['python3','-I','-S','-c','import os;print(os.getuid())']},undefined,undefined,{} as never);
      console.log(`Compatibility timings: ${JSON.stringify({startupMs,forwardedToolMs:Math.round(performance.now()-toolStarted)})}`);
      assert.match(JSON.stringify(result),/1000/);
      assert.equal(session.getToolDefinition('approve'),undefined);
      const planner=sandboxTools(guest,'planner',async()=>'',[]);
      assert.deepEqual(planner.map(t=>t.name).sort(),['ask_human','vm_list','vm_read','vm_search']);
      const reviewer=sandboxTools(guest,'reviewer',async()=>'',[]);
      assert.deepEqual(reviewer.map(t=>t.name).sort(),['ask_human','vm_check','vm_list','vm_read','vm_search']);
      config.environment.checks[0]!.platform='darwin-arm64';
      const unavailable=await reviewer.find(t=>t.name==='vm_check')!.execute('unsupported-check',{name:'tests'},undefined,undefined,{} as never);
      assert.match(JSON.stringify(unavailable),/unavailable/);assert.match(JSON.stringify(unavailable),/darwin-arm64/);
      delete config.environment.checks[0]!.platform;
      assert.match(await guest.inspect('list',''),/bytes.bin/);
      assert.match(await guest.inspect('search','','UNTRUSTED_EXTENSION_LOADED'),/evil.ts/);
      await assert.rejects(guest.inspect('list','../../'),/path|escape/i);
    }finally{session.dispose();}
    assert.equal((await guest.execute(['python3','-I','-S','-c',`open(b'/workspace/invalid-\\xff','wb').write(b'payload')`])).code,0);
    await assert.rejects(guest.export(root),/path|UTF-8|artifact/i,'Guest filenames with invalid UTF-8 bytes must not become a different host Git candidate');
    // Export freezes source even when validation refuses its manifest. Fixture
    // cleanup therefore uses the trusted helper, never a reviewer/model tool.
    assert.equal((await guest.root(['python3','-I','-S','-c',`import os;os.unlink(b'/workspace/invalid-\\xff')`])).code,0);
    await guest.freeze();
    assert.notEqual((await guest.execute(['sh','-c','echo changed > bytes.bin'])).code,0);
    assert.equal((await guest.execute(['sh','-c','echo cached > node_modules/package/value'])).code,0,'Registered disposable dependency caches remain writable while tracked source is frozen');
    const exported=await guest.export(root);assert.equal(exported.hash,source.hash);
    const active=guest.execute(['sh','-c','sleep 100 & wait']);
    await new Promise(resolve=>setTimeout(resolve,200));
    await guest.close();await assert.rejects(active);
    assert.equal((await Machine.list(LOCAL)).some(m=>m.labels.owner===owner),false);
  }finally{await guest?.close();await rm(root,{recursive:true,force:true});}
});

test('fixture task produces a reviewed local candidate through both human gates with bounded repair', {timeout:240000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-workflow-'));const repository=join(root,'target');
  await privateDirectory(repository);await privateDirectory(join(root,'.factory'));
  const config=fixtureConfig(repository);
  await git(repository,['init','--initial-branch=main','--quiet']);
  await writeFile(join(repository,'value.txt'),'old\n');
  const originalCheck='from pathlib import Path\nassert Path("value.txt").read_text().strip() in ("old", "new")\n';
  await writeFile(join(repository,'check.py'),originalCheck);
  await git(repository,['add','value.txt','check.py']);
  await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','fixture base']);
  const store=new Store(join(root,'.factory'));const linear=new Linear(config,root);
  linear.issue=async()=>issue;linear.current=async()=>issue;
  const roles:string[]=[];let implementations=0;
  const workflow=new Workflow(config,store,linear,`fixture-${crypto.randomUUID()}`,root,
    async(role,guest)=>{
      roles.push(role);
      if(role==='planner')return JSON.stringify({summary:'Change value and preserve checks',paths:['value.txt','check.py'],acceptance:['value is new'],steps:['Update value.txt and preserve its check']});
      if(role==='implementer'){
        implementations++;await guest.write('value.txt',implementations<3?'broken\n':'new\n');
        if(implementations===2)await guest.write('check.py','pass\n'); // attempt to hide the defect
        if(implementations===3)await guest.write('check.py',originalCheck);
        return 'Implemented';
      }
      const check=await guest.execute(['python3','-I','-S','-c','from pathlib import Path;assert Path("value.txt").read_text()=="new\\n"']);
      const preserved=(await guest.read('check.py')).trim()===originalCheck.trim();
      return JSON.stringify({findings:preserved?[]:[{location:'check.py:1',severity:'blocking',impact:'Removed the existing assertion to hide the defect',correction:'Restore the assertion and fix value.txt'}],
        acceptance:[{criterion:'value is new',passed:check.code===0&&preserved,evidence:`Independent guest assertion exit ${check.code}; original check preserved: ${preserved}`}]});
    });
  try{
    const run=await workflow.plan('ENG-42');await workflow.active?.done;
    assert.equal(run.status,'awaiting_plan_approval');assert.equal(implementations,0);
    const baselineLog=run.baseline[0]!.log;
    await workflow.revise(run,'Clarify the plan while retaining the same acceptance criterion');await workflow.active?.done;
    assert.equal(run.status,'awaiting_plan_approval',run.blocker??'Expected plan gate');
    assert.equal(run.baseline[0]!.log,baselineLog,'Replanning the same base/profile reuses validated baseline evidence');
    await writeFile(baselineLog,'tampered evidence');
    await assert.rejects(workflow.approve(run,'plan',run.planHash!),/evidence changed/);
    await workflow.revise(run,'Revalidate the baseline after evidence changed');await workflow.active?.done;
    assert.equal(run.status,'awaiting_plan_approval',run.blocker??'Expected plan gate');
    assert.notEqual(run.baseline[0]!.log,baselineLog,'Tampered baseline logs require a new guest check');
    await assert.rejects(workflow.approve(run,'plan','0'.repeat(64)),/match/);
    await workflow.approve(run,'plan',run.planHash!);await workflow.active?.done;
    assert.equal(run.status,'awaiting_merge_approval',run.blocker??'Expected a reviewed candidate');
    assert.equal(run.repairCount,2);assert.equal(implementations,3);
    assert.deepEqual(roles,['planner','planner','planner','implementer','implementer','reviewer','implementer','reviewer']);
    assert.ok(run.candidate?.checks.every(c=>c.outcome==='passed'));assert.ok(run.candidate?.evidenceHash);
    const snapshot=await readSnapshot(join(root,'.factory/artifacts'),run.candidate!.hash,config.limits);
    assert.equal((await readFile(join(snapshot.directory,'source/value.txt'),'utf8')),'new\n');
    assert.equal(await readFile(join(repository,'value.txt'),'utf8'),'old\n','Original host checkout must be unchanged');
    await assert.rejects(workflow.approve(run,'candidate',run.candidate!.hash),/changed/);
    await workflow.approve(run,'candidate',run.candidate!.evidenceHash!);
    assert.equal(run.status,'ready_for_manual_merge');
    assert.equal((await git(run.candidate!.repository,['show',`${run.candidate!.commit}:value.txt`])).toString(),'new\n');
    assert.equal(store.unresolvedVMs().length,0);
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});

test('a real VM task retains an approved preexisting failure and optional unavailable check without accepting new failure evidence',{timeout:150000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-baseline-policy-'));const repository=join(root,'target');
  await privateDirectory(repository);await privateDirectory(join(root,'.factory'));
  await git(repository,['init','--initial-branch=main','--quiet']);
  await writeFile(join(repository,'value.txt'),'old\n');
  await writeFile(join(repository,'check.py'),'from pathlib import Path\nassert Path("value.txt").read_text().strip() in ("old", "new")\n');
  await git(repository,['add','value.txt','check.py']);
  await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','base']);
  const config=fixtureConfig(repository);
  config.environment.checks.push({name:'legacy',argv:['python3','-I','-S','-c','print("known unrelated defect");raise SystemExit(1)'],
    timeoutSeconds:10,required:true,acceptBaselineFailure:{reason:'Existing unrelated defect; retain its exact exit code and output.'}},
    {name:'optional',argv:['sh','-c','factory-unavailable-command'],timeoutSeconds:10,required:false});
  const store=new Store(join(root,'.factory'));const linear=new Linear(config,root);linear.issue=async()=>issue;
  const workflow=new Workflow(config,store,linear,`fixture-policy-${crypto.randomUUID()}`,root,async(role,guest)=>{
    if(role==='planner')return JSON.stringify({summary:'Change value while preserving known baseline defect',paths:['value.txt'],acceptance:['value is new'],steps:['Write new value']});
    if(role==='implementer'){await guest.write('value.txt','new\n');return 'Done';}
    return JSON.stringify({findings:[],acceptance:[{criterion:'value is new',passed:(await guest.read('value.txt')).trim()==='new',evidence:'Read frozen source; registered baseline exception remains unchanged'}]});
  });
  try{
    const run=await workflow.plan('ENG-42');await workflow.active?.done;
    assert.equal(run.status,'awaiting_plan_approval',run.blocker??'Expected explicit baseline policy in plan gate');
    assert.equal(run.baseline[1]!.outcome,'failed');assert.equal(run.baseline[2]!.outcome,'unavailable');
    await workflow.approve(run,'plan',run.planHash!);await workflow.active?.done;
    assert.equal(run.status,'awaiting_merge_approval',run.blocker??'Expected frozen reviewed candidate');
    assert.equal(run.candidate!.checks[1]!.comparison,'preexisting');
    assert.equal(run.candidate!.checks[1]!.outcome,'failed','An accepted exception is still reported as a failure');
    assert.equal(run.candidate!.checks[2]!.outcome,'unavailable');assert.equal(run.repairCount,0);
    const log=run.candidate!.checks[1]!.log;const original=await readFile(log);
    await writeFile(log,'a new unrelated failure');
    await assert.rejects(workflow.approve(run,'candidate',run.candidate!.evidenceHash!),/evidence changed/);
    await writeFile(log,original);await workflow.approve(run,'candidate',run.candidate!.evidenceHash!);
    assert.equal(run.status,'ready_for_manual_merge');assert.equal(store.unresolvedVMs().length,0);
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});
