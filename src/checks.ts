import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import { paths, type Config } from './config.js';
import { fingerprint, hash } from './safety.js';
import type { CheckResult, Run } from './models.js';
import type { Store } from './storage.js';

export function unavailableCheck(check:Config['environment']['checks'][number]):string|undefined {
  if(check.platform&&check.platform!=='linux-arm64')return `Unavailable: check requires ${check.platform}; the configured runner is Linux/arm64`;
  return undefined;
}

// One most-recent baseline, not a cache service. Its logs remain ordinary run
// evidence and are revalidated before reuse or approval.
export function baselineKey(run:Run):string {
  return fingerprint({base:run.base,source:run.source,environment:run.config.environment,
    limits:run.config.limits,build:run.buildHash});
}
const ResultSchema=z.strictObject({name:z.string(),argv:z.array(z.string()),image:z.string(),source:z.string(),
  started:z.string(),ended:z.string(),code:z.number().int().nullable(),
  outcome:z.enum(['passed','failed','unavailable','skipped']),log:z.string(),logHash:z.string().regex(/^[a-f0-9]{64}$/),
  cwd:z.literal('/workspace'),environmentHash:z.string().regex(/^[a-f0-9]{64}$/),
  required:z.boolean(),comparison:z.enum(['preexisting','introduced']).optional()});

export function resultsComplete(run:Run,results:CheckResult[],source:string):boolean {
  const checks=run.config.environment.checks;
  return results.length===checks.length&&results.every((r,i)=>{
    const c=checks[i]!;
    return r.name===c.name&&fingerprint(r.argv)===fingerprint(c.argv)&&r.required===c.required
      &&r.image===run.config.environment.image&&r.source===source
      &&r.cwd==='/workspace'&&r.environmentHash===fingerprint(run.config.environment)
      &&(!unavailableCheck(c)||r.outcome==='unavailable'||r.outcome==='skipped')
      &&((r.outcome==='passed'&&r.code===0)||(r.outcome==='failed'&&r.code!==null&&r.code!==0)
        ||((r.outcome==='unavailable'||r.outcome==='skipped')&&r.code===null));
  });
}
export function matchingFailure(baseline:CheckResult|undefined,result:Pick<CheckResult,'code'|'outcome'|'logHash'>):boolean {
  return baseline?.outcome==='failed'&&result.outcome==='failed'&&baseline.code===result.code
    &&baseline.logHash===result.logHash;
}
export function baselineAccepted(run:Run):boolean {
  return resultsComplete(run,run.baseline,run.source)&&run.baseline.every((r,i)=>
    !r.required||r.outcome==='passed'||(r.outcome==='failed'&&Boolean(run.config.environment.checks[i]!.acceptBaselineFailure)));
}
export function verificationAccepted(run:Run):boolean {
  const results=run.candidate?.checks;
  return baselineAccepted(run)&&Boolean(results&&resultsComplete(run,results,run.candidate!.hash)
    &&results.every((r,i)=>!r.required||r.outcome==='passed'
      ||(Boolean(run.config.environment.checks[i]!.acceptBaselineFailure)&&matchingFailure(run.baseline[i],r))));
}
export async function verifyCheckLogs(root:string,run:Run,results:CheckResult[]):Promise<void> {
  const directory=resolve(paths(root).state,'runs');
  const canonicalDirectory=await realpath(directory);
  for(const result of results){
    const file=resolve(result.log);const path=relative(directory,file);
    if(!path||path.startsWith('..')||path.startsWith('/')||await realpath(file)!==resolve(canonicalDirectory,path))throw new Error('Check evidence path escaped private runs');
    const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>run.config.limits.maxOutputBytes)throw new Error('Check evidence file is unavailable or oversized');
    if(hash(await readFile(file))!==result.logHash)throw new Error('Check evidence changed');
  }
}
export async function cachedBaseline(store:Store,root:string,run:Run):Promise<CheckResult[]|undefined> {
  const value=store.setting('baseline');if(!value)return undefined;
  try{
    const cached=z.strictObject({key:z.string(),results:z.array(ResultSchema).max(20)}).parse(JSON.parse(value));
    if(cached.key!==baselineKey(run)||!resultsComplete(run,cached.results,run.source)||cached.results.some(r=>r.outcome==='unavailable'||r.outcome==='skipped'))return undefined;
    await verifyCheckLogs(root,run,cached.results);
    return cached.results;
  }catch{return undefined;}
}
export function saveBaseline(store:Store,run:Run):void {
  if(!resultsComplete(run,run.baseline,run.source))throw new Error('Incomplete baseline cannot be cached');
  store.setSetting('baseline',JSON.stringify({key:baselineKey(run),results:run.baseline}));
}
