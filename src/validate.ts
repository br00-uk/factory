import { basename, join } from 'node:path';
import { loadConfig, paths } from './config.js';
import { baseCommit, snapshotRepository } from './git.js';
import { Workspace, hostRunner } from './host.js';
import { atomicWrite, clean, privateDirectory } from './safety.js';

interface ValidatedCheck { name:string; argv:string[]; required:boolean; started:string; ended:string;
  code:number|null; outcome:'passed'|'failed'|'unavailable'|'skipped'; stdout:string; stderr:string }

// Prove the registered environment and check profile against the base commit in
// one fresh sandboxed workspace, without Linear, Herdr, a model, or a run record:
// dependency preparation, every registered check with egress denied, then a frozen
// export showing the checks leave tracked source unchanged. This is the "does the
// factory work for this repository" answer before any issue is planned. The
// evidence file is private and is not run evidence.
export async function validate(root:string):Promise<void> {
  const config=await loadConfig(root);const p=paths(root);
  const base=await baseCommit(config);
  const snapshot=await snapshotRepository(config,base,p.artifacts);
  const checks:ValidatedCheck[]=[];let exported:string|undefined;let failure:string|undefined;
  console.log(`Validating ${config.repository} at ${base} (source ${snapshot.hash.slice(0,16)}) in a fresh sandboxed workspace`);
  const workspace=await Workspace.create(config,'factory-validate','validation',undefined,root);
  try{
    await workspace.import(snapshot);await workspace.prepareDependencies();
    for(const check of config.environment.checks){
      const started=new Date().toISOString();
      if(workspace.stopped){checks.push({name:check.name,argv:check.argv,required:check.required,started,ended:started,code:null,outcome:'skipped',stdout:'',stderr:'Not run: preceding workspace execution unavailable'});continue;}
      try{
        const result=await workspace.execute(check.argv,{timeout:check.timeoutSeconds});
        const unavailable=result.code===126||result.code===127;
        checks.push({name:check.name,argv:check.argv,required:check.required,started,ended:new Date().toISOString(),
          code:unavailable?null:result.code,outcome:unavailable?'unavailable':result.code===0?'passed':'failed',stdout:result.stdout,stderr:result.stderr});
      }catch(e){
        checks.push({name:check.name,argv:check.argv,required:check.required,started,ended:new Date().toISOString(),code:null,outcome:'unavailable',stdout:'',stderr:(e as Error).message});
      }
      const last=checks.at(-1)!;
      console.log(`${last.name}: ${last.outcome}${last.code?` (exit ${last.code})`:''} [${Math.round((Date.parse(last.ended)-Date.parse(last.started))/1000)}s]`);
    }
    if(!workspace.stopped)exported=(await workspace.export(p.artifacts)).hash;
  }catch(e){failure=(e as Error).message;}
  finally{await workspace.close();}
  const directory=join(p.state,'validation');await privateDirectory(directory);
  const file=join(directory,`${basename(config.repository)}-${crypto.randomUUID()}.json`);
  await atomicWrite(file,JSON.stringify({repository:config.repository,base,source:snapshot.hash,exported,runner:hostRunner(),
    environment:config.environment,limits:config.limits,preparation:workspace.preparation,checks,failure,verified:new Date().toISOString()},null,1));
  const problems:string[]=[];
  if(failure)problems.push(`Validation stopped: ${failure}`);
  for(const check of checks)if(check.required&&check.outcome!=='passed')problems.push(`${check.name}: ${check.outcome}${check.stderr?` — ${check.stderr.trim().split('\n').at(-1)}`:''}`);
  if(exported&&exported!==snapshot.hash)problems.push('Registered checks changed tracked source; checks must clean generated files');
  if(!exported&&!failure)problems.push('Frozen export unavailable; tracked source integrity after checks is unproven');
  console.log(`Evidence: ${file}`);
  if(problems.length){for(const problem of problems)console.error(clean(problem));throw new Error('Environment validation failed');}
  console.log('Environment validation passed: preparation, every required check, and unchanged tracked source.');
}
