import { readFile, chmod, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { ConfigSchema, paths, type Config } from './config.js';
import { git } from './git.js';
import { atomicWrite, clean, command, privateDirectory } from './safety.js';
import { installTools, verifySandbox } from './install.js';
import { doctor } from './doctor.js';
import { validate } from './validate.js';
import { supervisorHealth, startDetachedSupervisor } from './workspace.js';

export interface InitOptions {
  repository?: string; organization?: string; team?: string; project?: {name:string;url:string};
  /** `provider/model-id`; defaults to the existing configuration or the Pi subscription found in ~/.pi/agent/auth.json. */
  model?: string;
  validate?: boolean; start?: boolean;
  log?: (line:string)=>void;
}
export interface InitResult { repository:string; baseRef:string; checks:string[]; configPath:string; validated:'passed'|'failed'|'skipped';
  supervisor:'started'|'running'|'not-started'; warnings:string[]; next:string[] }

const DEFAULT_LIMITS={stageSeconds:2700,activeSeconds:7200,commandSeconds:1800,maxOutputBytes:1048576,maxFileBytes:2097152,maxArtifactBytes:33554432,maxTurns:30};
const GO_HOSTS=['proxy.golang.org','sum.golang.org','storage.googleapis.com'];

/** Detect the repository's own verification gate from its build files. Every
 *  command runs in the sandbox with the host toolchain; dependency downloads get
 *  an explicit registry allowlist and persistent caches under the factory. */
export async function detectEnvironment(repository:string):Promise<Config['environment']> {
  const has=(name:string)=>existsSync(join(repository,name));
  const checks:Config['environment']['checks']=[];const env:Record<string,string>={CI:'true'};
  const deps:string[]=[];const hosts=new Set<string>();const generated:string[]=[];
  if(has('go.mod')){
    checks.push({name:'go-build',argv:['go','build','./...'],timeoutSeconds:1200,required:true},
      {name:'go-vet',argv:['go','vet','./...'],timeoutSeconds:1200,required:true},
      {name:'go-test-race',argv:['go','test','-race','./...'],timeoutSeconds:2400,required:true});
    Object.assign(env,{GOFLAGS:'-buildvcs=false',GOTOOLCHAIN:'local',GOCACHE:'${FACTORY_CACHE}/go-build',GOMODCACHE:'${FACTORY_CACHE}/go-mod',GOPROXY:'https://proxy.golang.org',GOSUMDB:'sum.golang.org'});
    deps.push('go mod download');GO_HOSTS.forEach(h=>hosts.add(h));
  }
  if(has('package.json')){
    const pkg=JSON.parse(await readFile(join(repository,'package.json'),'utf8')) as {scripts?:Record<string,string>};
    const scripts=pkg.scripts??{};
    const lockfile=has('package-lock.json');
    for(const name of ['build','typecheck','lint','test'])if(scripts[name])checks.push({name:`npm-${name}`,argv:['npm','run',name],timeoutSeconds:1200,required:name==='test'||name==='build'});
    if(!scripts.test&&!scripts.build)checks.push({name:'npm-install-only',argv:['npm','ls'],timeoutSeconds:300,required:false});
    env.NPM_CONFIG_CACHE='${FACTORY_CACHE}/npm';
    deps.push(lockfile?'npm ci --ignore-scripts --no-audit --no-fund':'npm install --ignore-scripts --no-audit --no-fund');
    hosts.add('registry.npmjs.org');generated.push('node_modules');
  }
  if(has('Cargo.toml')){
    checks.push({name:'cargo-build',argv:['cargo','build','--locked'],timeoutSeconds:2400,required:true},{name:'cargo-test',argv:['cargo','test','--locked'],timeoutSeconds:2400,required:true});
    env.CARGO_HOME='${FACTORY_CACHE}/cargo';deps.push('cargo fetch --locked');['crates.io','static.crates.io','index.crates.io'].forEach(h=>hosts.add(h));generated.push('target');
  }
  if(has('pyproject.toml')||has('pytest.ini')||has('setup.py'))checks.push({name:'pytest',argv:['python3','-m','pytest','-q'],timeoutSeconds:1800,required:true});
  if(!checks.length&&has('Makefile')){
    const makefile=await readFile(join(repository,'Makefile'),'utf8');
    for(const target of ['verify','check','test'])if(new RegExp(`^${target}:`,'m').test(makefile)){checks.push({name:`make-${target}`,argv:['make',target],timeoutSeconds:2400,required:true});break;}
  }
  if(!checks.length)throw new Error('No verification gate detected (go.mod, package.json scripts, Cargo.toml, pytest, or a Makefile verify/check/test target). Add checks to factory.local.json by hand.');
  const environment:Config['environment']={env,sandbox:{denyRead:[],allowRead:[]},checks};
  if(deps.length)environment.dependencies={argv:['sh','-c',`set -eu; ${deps.join('; ')}`],timeoutSeconds:1800,allowHosts:[...hosts],paths:generated};
  return environment;
}
async function detectModel(existing:Partial<Config>|undefined,requested?:string):Promise<Config['model']> {
  if(requested){
    const [provider,...rest]=requested.split('/');const id=rest.join('/');
    if(!provider||!id)throw new Error('Use --model provider/model-id');
    const authFile=join(homedir(),'.pi/agent/auth.json');
    return existsSync(authFile)?{provider,id,authFile,maxOutputTokens:8192}:{provider,id,apiKeyEnv:`${provider.toUpperCase().replaceAll(/[^A-Z0-9]/g,'_')}_API_KEY`,maxOutputTokens:8192};
  }
  if(existing?.model)return existing.model;
  const authFile=join(homedir(),'.pi/agent/auth.json');
  if(existsSync(authFile)){
    try{
      const auth=JSON.parse(await readFile(authFile,'utf8')) as Record<string,{type?:string}>;
      if(auth['openai-codex']?.type==='oauth')return {provider:'openai-codex',id:'gpt-5.5',authFile,maxOutputTokens:8192};
      const provider=Object.entries(auth).find(([,v])=>v?.type==='oauth')?.[0];
      if(provider)throw new Error(`Pi is signed in to ${provider}; pass --model ${provider}/<model-id> to choose the model`);
    }catch(e){if((e as Error).message.startsWith('Pi is signed in'))throw e;}
  }
  throw new Error('No model configured: sign in with Pi /login (subscription) or pass --model provider/model-id with its API key environment reference');
}
async function detectLinear(root:string,existing:Partial<Config>|undefined,options:InitOptions,warnings:string[]):Promise<Config['linear']> {
  if(options.project&&options.organization)return {organization:options.organization,project:options.project};
  if(options.team&&options.organization)return {organization:options.organization,team:options.team};
  if(options.team&&existing?.linear?.organization)return {organization:existing.linear.organization,team:options.team};
  if(existing?.linear)return existing.linear;
  let organization=options.organization;
  if(!organization){
    try{
      const listing=(await command([join(paths(root).tools,'linear-tui'),'auth','list'],{timeoutMs:15_000})).stdout.toString();
      const match=/https:\/\/linear\.app\/([a-z0-9-]+)/.exec(listing)??/^\s*\*?\s*([a-z0-9-]+)\s*$/m.exec(listing);
      if(match)organization=match[1]!;
    }catch{/* not signed in yet */}
  }
  if(!organization||!options.team)throw new Error(`Linear scope is required: rerun with --org <organization-url-key> --team <TEAM> (or --project-name/--project-url). ${warnings.length?warnings.join(' '):''}`.trim());
  return {organization,team:options.team};
}
export async function init(root:string,options:InitOptions={}):Promise<InitResult> {
  const log=options.log??((line:string)=>console.log(line));
  const warnings:string[]=[];const next:string[]=[];
  const p=paths(root);
  for(const directory of [p.state,p.artifacts,p.sessions,p.work,p.cache])await privateDirectory(directory);
  const requested=await realpath(options.repository??process.cwd());
  const repository=(await git(requested,['rev-parse','--show-toplevel'])).toString().trim();
  if(!repository)throw new Error('Run factory init inside a Git repository');
  let baseRef=(await git(repository,['rev-parse','--abbrev-ref','HEAD'])).toString().trim();
  if(baseRef==='HEAD'){
    for(const candidate of ['main','master']){try{await git(repository,['rev-parse','--verify',`${candidate}^{commit}`]);baseRef=candidate;break;}catch{/* try next */}}
    if(baseRef==='HEAD')throw new Error('Detached HEAD without main/master; check out the branch the factory should plan against');
  }
  let existing:Partial<Config>|undefined;
  try{existing=JSON.parse(await readFile(p.config,'utf8')) as Partial<Config>;}catch{/* first registration */}
  log(`Repository ${repository} (base ${baseRef})`);
  log('Installing pinned tools');await installTools(root);
  const environment=await detectEnvironment(repository);
  log(`Detected checks: ${environment.checks.map(c=>c.name).join(', ')}${environment.dependencies?` · dependencies: ${environment.dependencies.argv.at(-1)}`:''}`);
  const model=await detectModel(existing,options.model);
  const linear=await detectLinear(root,existing,options,warnings);
  const config=ConfigSchema.parse({repository,baseRef,linear,model,budgetUsd:existing?.budgetUsd??null,
    ...(existing?.telegram?{telegram:existing.telegram}:{}),environment,
    limits:{...DEFAULT_LIMITS,...(existing?.limits&&typeof existing.limits==='object'?Object.fromEntries(Object.entries(existing.limits).filter(([k])=>k in DEFAULT_LIMITS)):{})}});
  await atomicWrite(p.config,JSON.stringify(config,null,2)+'\n');await chmod(p.config,0o600);
  log(`Wrote ${p.config}`);
  if(!existsSync(join(p.state,'host.json'))){log('Verifying the host sandbox');await verifySandbox(config,root);}
  await doctor(root,{herdr:false,requireLinear:false,warn:message=>{warnings.push(message);}});
  let validated:InitResult['validated']='skipped';
  if(options.validate??true){
    log('Running the registered checks in a sandboxed workspace (this proves the profile)');
    try{await validate(root);validated='passed';}
    catch(e){validated='failed';warnings.push(`Validation failed: ${clean((e as Error).message)}; fix the repository or the checks in factory.local.json, then run factory validate`);}
  }
  let supervisor:InitResult['supervisor']='not-started';
  if(options.start??true){
    const health=await supervisorHealth(root);
    if(health){
      if(health.configHash!==(await import('./config.js')).configHash(config)){await (await import('./workspace.js')).down(root);supervisor=await startDetachedSupervisor(root,config)?'started':'not-started';}
      else supervisor='running';
    } else supervisor=await startDetachedSupervisor(root,config)?'started':'not-started';
  }
  if(warnings.some(w=>w.includes('Linear is not signed in')))next.push(`${join(p.tools,'linear-tui')} auth login`);
  next.push(`/factory plan ${config.linear.team?`${config.linear.team}-<number>`:'<issue-id-or-url>'}  (or: factory plan ...)`);
  const file=await lstat(p.config);if(file.mode&0o077)await chmod(p.config,0o600);
  return {repository,baseRef,checks:config.environment.checks.map(c=>c.name),configPath:p.config,validated,supervisor,warnings,next};
}
