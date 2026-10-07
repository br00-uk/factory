import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, lstat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean, relativePath, privateDirectory, command, hostEnvironment } from '../src/safety.js';
import { git, snapshotRepository } from '../src/git.js';
import { storeSnapshot, readSnapshot, validateManifest, enforceScope, cleanup } from '../src/artifacts.js';
import { lock } from '../src/lock.js';
import { Store } from '../src/storage.js';
import { Linear, selectedIssue } from '../src/linear.js';
import { parseCommand } from '../src/control.js';
import { fixtureConfig, fixtureRun, issue } from './fixtures.js';
import { reserveRequest, modelRuntime } from '../src/pi.js';
import { ConfigSchema, projectPath, loadConfig } from '../src/config.js';
import type { Api, Model } from '@earendil-works/pi-ai';

test('terminal controls and referenced secrets never reach rendered text',()=>{
  assert.equal(clean('\x1b]52;c;evil\x07\x1b[31mhello\x1b[0m\x1b[2J\u202e token',['token']),'hello [redacted]');
});
test('source paths and manifests reject escape, aliases, collisions and oversized files',()=>{
  for(const path of ['../x','/etc/passwd','x/../y','x/.git/config','x\\y','x\0y','x\u0085y','x\u202ey','x\udcffy'])assert.throws(()=>relativePath(path));
  const config=fixtureConfig('/tmp');const file={path:'x',mode:'100644',size:1,sha256:'a'.repeat(64)};
  assert.throws(()=>validateManifest([file,{...file,path:'X'}],config.limits));
  assert.throws(()=>validateManifest([file,{...file,path:'x/y'}],config.limits));
  assert.throws(()=>validateManifest([{...file,size:config.limits.maxFileBytes+1}],config.limits));
  assert.throws(()=>enforceScope(['checks.py'],['src']));
});
test('binary snapshots retain bytes and detect tampering',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-artifacts-'));
  try{
    const config=fixtureConfig('/tmp');const data=Buffer.from([0,255,128,13,10]);
    const snapshot=await storeSnapshot(root,[{path:'src/bytes.bin',mode:'100644',data}],config.limits);
    assert.deepEqual(await readFile(join(snapshot.directory,'source/src/bytes.bin')),data);
    await readSnapshot(root,snapshot.hash,config.limits);
    await writeFile(join(snapshot.directory,'source/src/bytes.bin'),Buffer.from([0,255,129,13,10]));
    await assert.rejects(readSnapshot(root,snapshot.hash,config.limits),/integrity/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('Git snapshots reject invalid UTF-8 paths and cannot execute a repository-configured lazy-fetch helper',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-git-boundary-'));const repository=join(root,'target');await privateDirectory(repository);
  try{
    await git(repository,['init','--initial-branch=main','--quiet']);const config=fixtureConfig(repository);
    const object=async(type:string,data:Buffer)=>{
      const bytes=Buffer.concat([Buffer.from(`${type} ${data.length}\0`),data]);const id=createHash('sha1').update(bytes).digest('hex');
      const directory=join(repository,'.git/objects',id.slice(0,2));await privateDirectory(directory);
      await writeFile(join(directory,id.slice(2)),deflateSync(bytes));return id;
    };
    const blob=await object('blob',Buffer.from('source\n'));
    const commit=async(tree:string)=>object('commit',Buffer.from(`tree ${tree}\nauthor Fixture <fixture@localhost> 1 +0000\ncommitter Fixture <fixture@localhost> 1 +0000\n\nfixture\n`));
    const malformed=await object('tree',Buffer.concat([Buffer.from('100644 invalid-'),Buffer.from([255,0]),Buffer.from(blob,'hex')]));
    await assert.rejects(snapshotRepository(config,await commit(malformed),join(root,'artifacts')),/valid UTF-8/);
    const missing='1'.repeat(40);const tree=await object('tree',Buffer.concat([Buffer.from('100644 missing.txt\0'),Buffer.from(missing,'hex')]));
    const marker=join(root,'helper-executed');const helper=join(root,'helper.sh');
    await writeFile(helper,`#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`,{mode:0o700});
    for(const [key,value] of [['core.repositoryFormatVersion','1'],['extensions.partialClone','origin'],['remote.origin.promisor','true'],
      ['remote.origin.partialCloneFilter','blob:none'],['protocol.ext.allow','always'],['remote.origin.url',`ext::/bin/sh ${helper}`]])await git(repository,['config',key!,value!]);
    await assert.rejects(snapshotRepository(config,await commit(tree),join(root,'artifacts')),/Git|git|object|fetch|process|command/i);
    await assert.rejects(lstat(marker),{code:'ENOENT'},'Factory reads must not run the configured transport helper');
    const control=await command(['/usr/bin/git','-C',repository,'cat-file','blob',missing],{env:hostEnvironment({GIT_NO_LAZY_FETCH:'0'}),timeoutMs:5000});
    assert.notEqual(control.code,0);assert.equal(await readFile(marker,'utf8'),'executed','The fixture proves this repository would execute a helper without the lazy-fetch guard');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('idle cleanup preserves pending approval and completed-stage artifacts while removing an orphan snapshot',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-cleanup-'));const artifacts=join(root,'artifacts');await privateDirectory(artifacts);
  const config=fixtureConfig('/tmp');const store=new Store(root);
  try{
    const snapshot=async(value:string)=>storeSnapshot(artifacts,[{path:'value.txt',mode:'100644',data:Buffer.from(value)}],config.limits);
    const pending=await snapshot('pending');const completed=await snapshot('completed');const orphan=await snapshot('orphan');
    const run=fixtureRun(config);run.source=pending.hash;store.create(run);const stage=store.intent(run,'fixture stage');
    store.finish(stage,{candidate:{hash:completed.hash}});store.transition(run,'awaiting_plan_approval');
    assert.equal(await cleanup(artifacts,store.artifactReferences()),1);
    await readSnapshot(artifacts,pending.hash,config.limits);await readSnapshot(artifacts,completed.hash,config.limits);
    await assert.rejects(lstat(orphan.directory),{code:'ENOENT'});
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('lifetime OS lock refuses a second owner and releases at shutdown',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-lock-'));
  try{
    const release=await lock(root);await assert.rejects(lock(root),/lock|supervisor/);
    await release();const second=await lock(root);await second();
  }finally{await rm(root,{recursive:true,force:true});}
});
test('approval hashes, exclusive execution, crash recovery, and obsolete answers are enforced durably',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-store-'));await privateDirectory(root);
  let store=new Store(root);
  try{
    const run=fixtureRun(fixtureConfig('/tmp'));store.create(run);
    const other={...run,id:'F-1123456789ab',issue:{...issue,id:'9a0e0000-0000-4000-8000-000000000002'}};
    assert.throws(()=>store.create(other),/execution slot/);
    store.transition(run,'awaiting_plan_approval');run.planHash='c'.repeat(64);store.save(run);
    assert.throws(()=>store.approve(run,'plan','d'.repeat(64),'human'),/does not match/);
    store.approve(run,'plan',run.planHash,'human');assert.equal(store.approved(run),true);
    store.transition(run,'implementing');const attempt=store.intent(run,'input');store.finish(attempt,{saved:'candidate'});
    store.close();store=new Store(root);store.interrupt();assert.equal(store.get(run.id).status,'interrupted');
    assert.equal(store.db.prepare('SELECT result FROM stages WHERE id=?').get(attempt)?.result,'{"saved":"candidate"}');
    store.revoke(run);assert.equal(store.approved(run),false);
    run.status='awaiting_input';run.previous='implementing';store.save(run);
    store.request({id:'Q-0123456789ab',run:run.id,stage:'implementing',context:run.planHash,question:'How?',pending:true,created:new Date().toISOString()});
    store.answer(run,'Q-0123456789ab','Proceed within scope');
    assert.equal(store.get(run.id).status,'awaiting_input'); // a reply alone never resumes recovered work
    assert.throws(()=>store.answer(run,'Q-0123456789ab','duplicate'),/Obsolete/);
    run.status='cancelled';store.save(run);assert.throws(()=>store.answer(run,'Q-0123456789ab','late'),/Obsolete/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('Linear URL/context parsing refuses different organization, stale views, and partial selections',()=>{
  const config=fixtureConfig('/tmp');const linear=new Linear(config);
  assert.equal(linear.identifier(issue.url),'ENG-42');
  assert.throws(()=>linear.identifier('https://linear.app/other/issue/ENG-42'),/organization/);
  assert.throws(()=>linear.identifier('OTHER-42'),/team/);
  const view={version:1,organization:{id:issue.team_id,url_key:'factory-fixture'},screen:'issue_list',
    rows:[{kind:'issue',id:issue.id,identifier:'ENG-42'}],selected_row:0};
  assert.deepEqual(selectedIssue(view,config),{id:issue.id,identifier:'ENG-42'});
  assert.throws(()=>selectedIssue({...view,selected_row:2},config),/partial/);
  assert.throws(()=>selectedIssue({...view,closed_at:'yesterday'},config),/Stale/);
});
test('read-only Linear project resolution binds issue UUID membership and the exact returned project URL',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-project-'));const tools=join(root,'.cache/tools');
  await privateDirectory(tools);
  const project={id:'9a0e0000-0000-4000-8000-000000000003',name:'Salesbook',url:'https://linear.app/factory-fixture/project/salesbook-fd9671bd1086'};
  const dataFile=join(root,'data.json');
  await writeFile(join(tools,'linear-tui'),`#!${process.execPath}\nconst fs=require('node:fs');const d=JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)},'utf8'));console.log(JSON.stringify(process.argv[2]==='project'?d.project:d.issue));\n`,{mode:0o700});
  const config=fixtureConfig('/tmp');config.linear.project={name:'Salesbook',url:project.url+'/overview'};delete config.linear.team;
  const linear=new Linear(ConfigSchema.parse(config),root);
  try{
    await writeFile(dataFile,JSON.stringify({project,issue:{...issue,project:{id:project.id,name:'Salesbook'}}}));
    assert.equal((await linear.issue('ENG-42')).project?.id,project.id);
    await writeFile(dataFile,JSON.stringify({project,issue:{...issue,project:{id:issue.id,name:'Salesbook'}}}));
    await assert.rejects(linear.issue('ENG-42'),/outside.*project/);
    await writeFile(dataFile,JSON.stringify({project:{...project,url:'https://linear.app/other/project/salesbook-fd9671bd1086'},issue:{...issue,project:{id:project.id,name:'Salesbook'}}}));
    await assert.rejects(linear.issue('ENG-42'),/another project identity/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('selected Linear context retains the organization UUID and refuses a different account identity at a later boundary',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-organization-'));const tools=join(root,'.cache/tools');await privateDirectory(tools);
  const dataFile=join(root,'linear-fixture.json');
  await writeFile(join(tools,'linear-tui'),`#!/usr/bin/env node\nimport fs from 'node:fs';const d=JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)},'utf8'));console.log(JSON.stringify(process.argv[2]==='context'?d.view:d.issue));\n`,{mode:0o700});
  const config=fixtureConfig('/tmp');const linear=new Linear(config,root);
  const organizationId='ab120000-0000-4000-8000-000000000001';
  const fixture={issue,view:{workspace:'/tmp',running:true,snapshot:{version:1,organization:{id:organizationId,url_key:'factory-fixture'},
    screen:'issue_list',rows:[{kind:'issue',id:issue.id,identifier:issue.identifier}],selected_row:0}}};
  try{
    await writeFile(dataFile,JSON.stringify(fixture));assert.equal((await linear.current()).id,issue.id);
    assert.equal(linear.organizationId,organizationId);await linear.confirmOrganization(organizationId);
    fixture.view.snapshot.organization.id='ab120000-0000-4000-8000-000000000002';
    await writeFile(dataFile,JSON.stringify(fixture));await assert.rejects(linear.confirmOrganization(organizationId),/organization changed/);
    fixture.view.snapshot.rows[0]!.id='9a0e0000-0000-4000-8000-000000000002';
    await writeFile(dataFile,JSON.stringify(fixture));await assert.rejects(linear.current(),/UUID changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('human command parsing requires a specific gate hash and keeps messages as data',()=>{
  assert.throws(()=>parseCommand(['approve','F-0123456789ab']),/exactly one/);
  const request=parseCommand(['answer','F-0123456789ab','--request','Q-0123456789ab','--message','$(touch','/tmp/evil)']);
  assert.equal(request.message,'$(touch /tmp/evil)');
});
test('host command wrapper bounds output and timeout with confirmed process exit',async()=>{
  await assert.rejects(command([process.execPath,'-e','process.stdout.write("x".repeat(10000))'],{maxBytes:100}),/output limit/);
  await assert.rejects(command([process.execPath,'-e','setInterval(()=>{},1000)'],{timeoutMs:50}),/timed out/);
});
test('model spend is reserved durably before a request; exhaustion and revocation refuse a new turn',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-spend-'));const store=new Store(root);
  try{
    const run=fixtureRun(fixtureConfig('/tmp'));store.create(run);
    const model={contextWindow:1000,cost:{input:1,output:2,cacheRead:0.1,cacheWrite:1.2,
      tiers:[{inputTokensAbove:500,input:3,output:4,cacheRead:0.2,cacheWrite:3.5}]}} as Model<Api>;
    reserveRequest(run,store,model);assert.equal(store.get(run.id).turns,1);assert.ok(store.get(run.id).spentUsd>0);
    run.config.budgetUsd=run.spentUsd;assert.throws(()=>reserveRequest(run,store,model),/before request/);
    run.config.budgetUsd=5;run.status='implementing';store.save(run);
    assert.throws(()=>reserveRequest(run,store,model),/revoked/);
    run.status='cancelled';store.save(run);assert.throws(()=>reserveRequest(run,store,model),/cannot request/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('subscription mode has no dollar cap but keeps durable turns and approval authority',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-subscription-'));const store=new Store(root);
  try{
    const config=fixtureConfig('/tmp');config.budgetUsd=null;
    const run=fixtureRun(config);store.create(run);
    const unknownPricing={} as Model<Api>;
    reserveRequest(run,store,unknownPricing);
    assert.equal(store.get(run.id).spentUsd,0);assert.equal(store.get(run.id).turns,1);
    run.turns=config.limits.maxTurns;assert.throws(()=>reserveRequest(run,store,unknownPricing),/turn limit/);
    run.turns=1;run.status='implementing';store.save(run);
    assert.throws(()=>reserveRequest(run,store,unknownPricing),/revoked/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('Pi subscription uses only an explicit private OAuth file, without API keys or model network calls',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-oauth-'));const file=join(root,'auth.json');
  try{
    const config=fixtureConfig('/tmp');delete config.model.apiKeyEnv;
    config.model={provider:'openai-codex',id:'gpt-5.5',authFile:file,maxOutputTokens:4096};config.budgetUsd=null;
    await writeFile(file,JSON.stringify({'openai-codex':{type:'oauth',access:'test-access',refresh:'test-refresh',expires:Date.now()+3600000}}),{mode:0o600});
    const runtime=await modelRuntime(ConfigSchema.parse(config));
    assert.equal(runtime.getPhysicalModel('openai-codex','gpt-5.5')?.id,'gpt-5.5');
    assert.throws(()=>ConfigSchema.parse({...config,model:{...config.model,apiKeyEnv:'EXTRA_KEY'}}),/exactly one/);
    await writeFile(file,JSON.stringify({'openai-codex':{type:'api_key',key:'test'}}));
    await assert.rejects(modelRuntime(config),/Pi \/login/);
    assert.equal(projectPath('https://linear.app/neverzero/project/salesbook-fd9671bd1086/overview','neverzero'),'neverzero/project/salesbook-fd9671bd1086');
    assert.equal(projectPath('https://linear.app/other/project/salesbook-fd9671bd1086','neverzero'),undefined);
    assert.throws(()=>ConfigSchema.parse({...config,linear:{organization:'neverzero'}}),/team or project/);
    const repository=join(root,'target');await privateDirectory(repository);
    await writeFile(join(repository,'auth.json'),'{}',{mode:0o600});
    const alias=join(root,'outside-alias');await symlink(repository,alias);
    await writeFile(join(root,'factory.local.json'),JSON.stringify({...config,repository,model:{...config.model,authFile:join(alias,'auth.json')}}),{mode:0o600});
    await assert.rejects(loadConfig(root),/outside the target repository/,'A parent-directory alias cannot place host credentials in the target checkout');
  }finally{await rm(root,{recursive:true,force:true});}
});
