import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, lstat, readdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Workspace, cacheDirectory, hostRunner } from '../src/host.js';
import { storeSnapshot, readSnapshot } from '../src/artifacts.js';
import { sandboxTools, trustedLoader } from '../src/pi.js';
import { fixtureConfig, issue } from './fixtures.js';
import { privateDirectory } from '../src/safety.js';
import { Store } from '../src/storage.js';
import { Workflow } from '../src/workflow.js';
import { Linear } from '../src/linear.js';
import { git } from '../src/git.js';

// A private factory root per test keeps the sandbox cache and work directories
// out of the real installation.
async function factoryRoot(prefix:string):Promise<string>{const root=await mkdtemp(join(tmpdir(),prefix));await privateDirectory(join(root,'.factory'));return root;}

test('host sandbox boundary: confined writes, hidden credentials, denied network, explicit tools, frozen source, and termination', {timeout:180000},async()=>{
  const root=await factoryRoot('factory-host-');const artifacts=join(root,'.factory/artifacts');const config=fixtureConfig('/tmp');
  config.environment.env={FACTORY_TEST_INPUT:'configured'};
  config.environment.dependencies={argv:['sh','-c','mkdir -p node_modules/package; echo dependency > node_modules/package/value; ln -s value node_modules/package/link; echo cache > "$FACTORY_CACHE/proof"'],timeoutSeconds:10,allowHosts:[],paths:['node_modules']};
  const owner=`factory-test-${crypto.randomUUID()}`;let workspace:Workspace|undefined;
  try{
    const bootStarted=performance.now();
    workspace=await Workspace.create(config,owner,'compatibility',undefined,root);
    const startupMs=Math.round(performance.now()-bootStarted);
    assert.ok(workspace.dir.startsWith(join(root,'.factory/work')));
    const bytes=Buffer.from([0,255,128,13,10]);
    const source=await storeSnapshot(artifacts,[{path:'bytes.bin',mode:'100644',data:bytes},
      {path:'.pi/extensions/evil.ts',mode:'100644',data:Buffer.from('throw new Error("UNTRUSTED_EXTENSION_LOADED")')}],config.limits);
    await workspace.import(source);
    const forbidden=await storeSnapshot(artifacts,[{path:'node_modules/tracked.js',mode:'100644',data:Buffer.from('tracked')}],config.limits);
    await assert.rejects(workspace.import(forbidden),/overlap tracked source/);
    await workspace.prepareDependencies();
    assert.deepEqual(await readFile(join(workspace.src,'bytes.bin')),bytes);
    assert.equal(await readFile(join(cacheDirectory(root),'proof'),'utf8'),'cache\n','Registered dependency preparation may write the factory cache');
    const credential=[join(homedir(),'.pi/agent/auth.json'),join(homedir(),'.ssh/config'),join(homedir(),'.gitconfig')].find(path=>existsSync(path));
    const realSrc=await realpath(workspace.src);
    process.env.FACTORY_HOST_CANARY='must-not-leak';
    const boundary=await workspace.execute(['python3','-I','-S','-c',`import os,socket,sys,tempfile
assert os.environ.get('FACTORY_TEST_INPUT')=='configured'
assert 'FACTORY_HOST_CANARY' not in os.environ, 'host environment leaked into the sandbox'
assert os.path.realpath(tempfile.gettempdir())==os.path.realpath(${JSON.stringify(workspace.tmp)}), tempfile.gettempdir()
open(os.path.join(tempfile.gettempdir(),'scratch'),'w').write('ok')
assert os.path.isfile(os.environ['FACTORY_CACHE']+'/proof')
assert os.path.isfile('.git/index')
assert os.path.realpath(os.getcwd())==${JSON.stringify(realSrc)}, os.getcwd()
try:
  open(${JSON.stringify(join(root,'escaped.txt'))},'w').write('x'); raise SystemExit('wrote outside the workspace')
except PermissionError: pass
credential=${JSON.stringify(credential??'')}
if credential:
  try:
    open(credential).read(); raise SystemExit('read a host credential: '+credential)
  except PermissionError: pass
for host in ['1.1.1.1','example.com']:
  try:
    s=socket.create_connection((host,443),timeout=2); s.close(); raise SystemExit('Unexpected connection '+host)
  except (OSError,TimeoutError): pass
server=socket.socket(); server.bind(('127.0.0.1',0)); server.listen(1)
client=socket.create_connection(server.getsockname(),timeout=2); client.close(); server.close()
print('confined')`]);
    assert.equal(boundary.code,0,boundary.stderr+boundary.stdout);
    assert.match(boundary.stdout,/confined/);
    assert.equal(existsSync(join(root,'escaped.txt')),false);
    const loader=trustedLoader('implementer');assert.equal(loader.getExtensions().extensions.length,0);assert.equal(loader.getAgentsFiles().agentsFiles.length,0);
    const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
    const model=runtime.getModels()[0];assert.ok(model,'Pinned Pi has no static models');
    const tools=sandboxTools(workspace,'implementer',async()=>{throw new Error('No human answer in compatibility test');});
    const {session}=await createAgentSession({cwd:root,agentDir:root,modelRuntime:runtime,model,
      tools:tools.map(t=>t.name),customTools:tools,resourceLoader:loader,sessionManager:SessionManager.inMemory(root),
      settingsManager:SettingsManager.inMemory({cacheWarming:'off'})});
    try{
      assert.deepEqual(session.getActiveToolNames().sort(),['ask_human','exec','list_files','read_file','search_files','write_file']);
      assert.equal(session.getActiveToolNames().includes('bash'),false,'Pi built-in host tools are never offered to the model');
      // Exercise the actual registered SDK tool, without any paid provider request.
      const tool=session.getToolDefinition('exec')!;
      const toolStarted=performance.now();
      const result=await tool.execute('test-call',{argv:['python3','-I','-S','-c','import os;print(os.getcwd())']},undefined,undefined,{} as never);
      console.log(`Compatibility timings: ${JSON.stringify({startupMs,sandboxedToolMs:Math.round(performance.now()-toolStarted)})}`);
      assert.ok(JSON.stringify(result).includes(realSrc.replaceAll('/','\\/'))||JSON.stringify(result).includes(realSrc),'The exec tool runs in the workspace source directory');
      assert.equal(session.getToolDefinition('approve'),undefined);
      const planner=sandboxTools(workspace,'planner',async()=>'',[]);
      assert.deepEqual(planner.map(t=>t.name).sort(),['ask_human','list_files','read_file','search_files']);
      const reviewer=sandboxTools(workspace,'reviewer',async()=>'',[]);
      assert.deepEqual(reviewer.map(t=>t.name).sort(),['ask_human','list_files','read_file','run_check','search_files']);
      config.environment.checks[0]!.platform='linux-x64';
      const unavailable=await reviewer.find(t=>t.name==='run_check')!.execute('unsupported-check',{name:'tests'},undefined,undefined,{} as never);
      assert.match(JSON.stringify(unavailable),/unavailable/);assert.match(JSON.stringify(unavailable),/linux-x64/);
      delete config.environment.checks[0]!.platform;
      assert.match(await workspace.inspect('list',''),/bytes.bin/);
      assert.match(await workspace.inspect('search','','UNTRUSTED_EXTENSION_LOADED'),/evil.ts/);
      await assert.rejects(workspace.inspect('list','../../'),/path|escape/i);
      await assert.rejects(workspace.read('../factory.sqlite'),/path/i);
    }finally{session.dispose();}
    // APFS refuses filenames that are not valid UTF-8, so this half of the
    // boundary can only be exercised on Linux; path validation itself is covered
    // in boundaries.test.ts.
    const invalid=await workspace.execute(['python3','-I','-S','-c',`open(b'invalid-\\xff','wb').write(b'payload')`]);
    if(invalid.code===0){
      await assert.rejects(workspace.export(artifacts),/path|UTF-8|artifact/i,'Workspace filenames with invalid UTF-8 bytes must not become a different host Git candidate');
      // Export freezes source even when validation refuses its manifest; thaw before the fixture removes the file.
      await workspace.unfreeze();
      assert.equal((await workspace.execute(['python3','-I','-S','-c',`import os;os.unlink(b'invalid-\\xff')`])).code,0);
    }
    await workspace.freeze();
    assert.notEqual((await workspace.execute(['sh','-c','echo changed > bytes.bin'])).code,0,'Frozen source rejects writes inside the sandbox');
    assert.notEqual((await workspace.execute(['sh','-c','chmod u+w bytes.bin && echo changed > bytes.bin'])).code,0,'The sandbox, not only permission bits, protects frozen source');
    assert.equal((await workspace.execute(['sh','-c','echo cached > node_modules/package/value'])).code,0,'Registered disposable dependency caches remain writable while tracked source is frozen');
    const exported=await workspace.export(artifacts);assert.equal(exported.hash,source.hash);
    const active=workspace.execute(['sh','-c','sleep 100 & wait']);
    await new Promise(resolve=>setTimeout(resolve,300));
    const dir=workspace.dir;
    await workspace.close();await assert.rejects(active);
    assert.equal(existsSync(dir),false,'Closing a workspace deletes it');
    await assert.rejects(workspace.execute(['echo','later']),/stopped/);
  }finally{await workspace?.close();await rm(root,{recursive:true,force:true});}
});

async function fixtureRepository(root:string,check:string):Promise<string>{
  const repository=join(root,'target');await privateDirectory(repository);
  await git(repository,['init','--initial-branch=main','--quiet']);
  await writeFile(join(repository,'value.txt'),'old\n');await writeFile(join(repository,'check.py'),check);
  await git(repository,['add','value.txt','check.py']);
  await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','fixture base']);
  return repository;
}
const originalCheck='from pathlib import Path\nassert Path("value.txt").read_text().strip() in ("old", "new")\n';

test('fixture task produces a reviewed local candidate through both human gates with bounded repair', {timeout:240000},async()=>{
  const root=await factoryRoot('factory-workflow-');const repository=await fixtureRepository(root,originalCheck);
  const config=fixtureConfig(repository);
  const store=new Store(join(root,'.factory'));const linear=new Linear(config,root);
  linear.issue=async()=>issue;linear.current=async()=>issue;
  const roles:string[]=[];let implementations=0;
  const workflow=new Workflow(config,store,linear,`fixture-${crypto.randomUUID()}`,root,
    async(role,workspace)=>{
      roles.push(role);
      if(role==='planner')return JSON.stringify({summary:'Change value and preserve checks',paths:['value.txt','check.py'],acceptance:['value is new'],steps:['Update value.txt and preserve its check']});
      if(role==='implementer'){
        implementations++;await workspace.write('value.txt',implementations<3?'broken\n':'new\n');
        if(implementations===2)await workspace.write('check.py','pass\n'); // attempt to hide the defect
        if(implementations===3)await workspace.write('check.py',originalCheck);
        return 'Implemented';
      }
      const check=await workspace.execute(['python3','-I','-S','-c','from pathlib import Path;assert Path("value.txt").read_text()=="new\\n"'],{writable:false});
      const preserved=(await workspace.read('check.py')).trim()===originalCheck.trim();
      return JSON.stringify({findings:preserved?[]:[{location:'check.py:1',severity:'blocking',impact:'Removed the existing assertion to hide the defect',correction:'Restore the assertion and fix value.txt'}],
        acceptance:[{criterion:'value is new',passed:check.code===0&&preserved,evidence:`Independent sandboxed assertion exit ${check.code}; original check preserved: ${preserved}`}]});
    });
  try{
    const run=await workflow.plan('ENG-42');await workflow.active?.done;
    assert.equal(run.status,'awaiting_plan_approval',run.blocker??'Expected plan gate');assert.equal(implementations,0);
    assert.equal(run.baseline[0]!.runner,hostRunner());assert.equal(run.baseline[0]!.outcome,'passed');
    const baselineLog=run.baseline[0]!.log;
    await workflow.revise(run,'Clarify the plan while retaining the same acceptance criterion');await workflow.active?.done;
    assert.equal(run.status,'awaiting_plan_approval',run.blocker??'Expected plan gate');
    assert.equal(run.baseline[0]!.log,baselineLog,'Replanning the same base/profile reuses validated baseline evidence');
    await writeFile(baselineLog,'tampered evidence');
    await assert.rejects(workflow.approve(run,'plan',run.planHash!),/evidence changed/);
    await workflow.revise(run,'Revalidate the baseline after evidence changed');await workflow.active?.done;
    assert.equal(run.status,'awaiting_plan_approval',run.blocker??'Expected plan gate');
    assert.notEqual(run.baseline[0]!.log,baselineLog,'Tampered baseline logs require a new sandboxed check');
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
    assert.equal(store.unresolvedWorkspaces().length,0);
    assert.deepEqual(await readdir(join(root,'.factory/work')),[],'No stage workspace survives the run');
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});

test('a task retains an approved preexisting failure and optional unavailable check without accepting new failure evidence',{timeout:150000},async()=>{
  const root=await factoryRoot('factory-baseline-policy-');const repository=await fixtureRepository(root,originalCheck);
  const config=fixtureConfig(repository);
  config.environment.checks.push({name:'legacy',argv:['python3','-I','-S','-c','print("known unrelated defect");raise SystemExit(1)'],
    timeoutSeconds:10,required:true,acceptBaselineFailure:{reason:'Existing unrelated defect; retain its exact exit code and output.'}},
    {name:'optional',argv:['sh','-c','factory-unavailable-command'],timeoutSeconds:10,required:false});
  const store=new Store(join(root,'.factory'));const linear=new Linear(config,root);linear.issue=async()=>issue;
  const workflow=new Workflow(config,store,linear,`fixture-policy-${crypto.randomUUID()}`,root,async(role,workspace)=>{
    if(role==='planner')return JSON.stringify({summary:'Change value while preserving known baseline defect',paths:['value.txt'],acceptance:['value is new'],steps:['Write new value']});
    if(role==='implementer'){await workspace.write('value.txt','new\n');return 'Done';}
    return JSON.stringify({findings:[],acceptance:[{criterion:'value is new',passed:(await workspace.read('value.txt')).trim()==='new',evidence:'Read frozen source; registered baseline exception remains unchanged'}]});
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
    assert.equal(run.status,'ready_for_manual_merge');assert.equal(store.unresolvedWorkspaces().length,0);
    await assert.rejects(lstat(join(root,'escaped.txt')),{code:'ENOENT'});
  }finally{if(workflow.active)await workflow.stop(workflow.active.run,'cancelled');store.close();await rm(root,{recursive:true,force:true});}
});
