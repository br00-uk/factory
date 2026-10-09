import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../src/config.js';
import { Store } from '../src/storage.js';
import { baselineAccepted, cachedBaseline, saveBaseline, verificationAccepted, verifyCheckLogs } from '../src/checks.js';
import { hash, fingerprint, privateDirectory } from '../src/safety.js';
import { fixtureConfig, fixtureRun } from './fixtures.js';
import type { CheckResult } from '../src/models.js';
import { hostRunner } from '../src/host.js';

test('baseline reuse requires the same source/environment/check inputs and intact private logs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factory-baseline-'));await privateDirectory(join(root,'.factory'));
  const store=new Store(join(root,'.factory'));const run=fixtureRun(fixtureConfig('/tmp'));
  const log=join(root,'.factory/runs',run.id,'baseline.log');await privateDirectory(join(root,'.factory/runs',run.id));
  try{
    await writeFile(log,'ok',{mode:0o600});
    run.baseline=[{name:'tests',argv:run.config.environment.checks[0]!.argv,runner:hostRunner(),
      source:run.source,started:run.created,ended:run.created,code:0,outcome:'passed',required:true,log,logHash:hash('ok'),
      cwd:'/tmp/factory-fixture/src',environmentHash:fingerprint(run.config.environment)}];
    saveBaseline(store,run);assert.deepEqual(await cachedBaseline(store,root,run),run.baseline);
    for(const change of [
      (r:typeof run)=>{r.base='c'.repeat(40);},
      (r:typeof run)=>{r.source='c'.repeat(64);},
      (r:typeof run)=>{r.config.environment.env.CI='changed';},
      (r:typeof run)=>{r.config.environment.checks[0]!.argv=['different'];},
      (r:typeof run)=>{r.config.environment.sandbox.denyRead=['/other'];},
      (r:typeof run)=>{r.buildHash='d'.repeat(64);},
    ]){
      const changed=structuredClone(run);change(changed);assert.equal(await cachedBaseline(store,root,changed),undefined);
    }
    await writeFile(log,'tampered');assert.equal(await cachedBaseline(store,root,run),undefined);
    await assert.rejects(verifyCheckLogs(root,run,run.baseline),/changed/);
    run.baseline[0]!.log='/etc/passwd';assert.equal(await cachedBaseline(store,root,run),undefined);
    await assert.rejects(verifyCheckLogs(root,run,run.baseline),/escaped/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('only explicit baseline exceptions accept matching failures; required unavailable or missing evidence never passes',()=>{
  const config=fixtureConfig('/tmp');
  const run=fixtureRun(config);
  const result:CheckResult={name:'tests',argv:config.environment.checks[0]!.argv,runner:hostRunner(),
    source:run.source,started:run.created,ended:run.created,code:1,outcome:'failed',required:true,log:'/tmp/log',logHash:hash('known defect'),
    cwd:'/tmp/factory-fixture/src',environmentHash:fingerprint(config.environment)};
  run.baseline=[result];assert.equal(baselineAccepted(run),false);
  config.environment.checks[0]!.acceptBaselineFailure={reason:'Existing unrelated defect; preserve its exact failure output.'};
  result.environmentHash=fingerprint(config.environment);
  assert.equal(baselineAccepted(run),true);
  run.candidate={hash:'e'.repeat(64),commit:'a'.repeat(40),repository:'/tmp',diffPath:'/tmp/diff',diffHash:'a'.repeat(64),
    checks:[{...result,source:'e'.repeat(64)}]};
  assert.equal(verificationAccepted(run),true);
  run.candidate.checks[0]!.logHash=hash('new defect');assert.equal(verificationAccepted(run),false);
  run.candidate.checks[0]={...result,source:run.candidate.hash,code:null,outcome:'unavailable'};
  assert.equal(verificationAccepted(run),false);
  run.candidate.checks=[];assert.equal(verificationAccepted(run),false);
  config.environment.checks.push({...config.environment.checks[0]!,name:'advisory',required:false});
  result.environmentHash=fingerprint(config.environment);
  run.baseline.push({...result,name:'advisory',required:false,code:null,outcome:'unavailable'});
  run.candidate.checks=run.baseline.map(c=>({...c,source:run.candidate!.hash}));
  assert.equal(verificationAccepted(run),true,'Unavailable optional evidence remains visible without replacing required evidence');
  run.candidate.checks[0]!.argv=['forged-check'];assert.equal(verificationAccepted(run),false);
  assert.throws(()=>ConfigSchema.parse({...config,environment:{...config.environment,checks:[config.environment.checks[1]]}}),/required verification/);
  assert.throws(()=>ConfigSchema.parse({...config,environment:{...config.environment,checks:[config.environment.checks[0],config.environment.checks[0]]}}),/unique/);
});
