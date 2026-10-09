import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, paths, type Config } from './config.js';
import { baseCommit, git } from './git.js';
import { command, requireSuccess, hash, hostEnvironment } from './safety.js';
import { z } from 'zod';
import { pinnedTools } from './install.js';
import { modelRuntime } from './pi.js';
import { Linear } from './linear.js';
import { unavailableCheck } from './checks.js';
import { localAvailability } from './host.js';

export interface DoctorOptions {
  /** Require a running Herdr 0.9.1 session (make up inside Herdr). Default: only when HERDR_ENV=1. */
  herdr?: boolean;
  /** Treat a missing Linear sign-in as a failure (default) or report it through `warn`. */
  requireLinear?: boolean;
  warn?: (message: string) => void;
}
export async function doctor(root:string,options:DoctorOptions={}):Promise<Config> {
  const herdr=options.herdr??process.env.HERDR_ENV==='1';
  const warn=options.warn??((message:string)=>console.warn(`Warning: ${message}`));
  if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Use Apple Silicon macOS');
  if(!/^v26\.5\./.test(process.version))throw new Error('Use the pinned Node 26.5.x runtime');
  const config=await loadConfig(root);const p=paths(root);
  for(const check of config.environment.checks){const reason=unavailableCheck(check);if(check.required&&reason)throw new Error(`${check.name}: ${reason}`);}
  for(const directory of [p.state,p.artifacts,p.sessions]) {
    const stat=await lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw new Error(`Private directory permissions required: ${directory}; run make setup`);
  }
  const file=await lstat(p.config);
  if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077))throw new Error('factory.local.json must be a private regular file (chmod 600)');
  requireSuccess(await command(['python3','--version']));
  const sandbox=localAvailability();
  if(!sandbox.available)throw new Error(`Host sandbox unavailable: ${sandbox.reason}`);
  try{JSON.parse(await readFile(join(p.state,'host.json'),'utf8'));}catch{throw new Error('The host sandbox has not been verified on this installation; run make setup');}
  for(const [name,pin] of Object.entries(pinnedTools)) {
    if(name==='herdr'&&!herdr)continue;
    const binary=join(p.tools,name);const bytes=await readFile(binary);
    if(hash(bytes)!==(await readFile(`${binary}.pin`,'utf8')))throw new Error(`Pinned ${name} binary changed; make setup`);
    if(!requireSuccess(await command([binary,'--version'])).toString().includes(pin.version))throw new Error(`Incorrect ${name} version`);
  }
  if(herdr){
    if(process.env.HERDR_ENV!=='1')throw new Error('Run make doctor/up from a Herdr pane (HERDR_ENV=1), or use factory up outside Herdr');
    const server=z.object({server:z.object({running:z.boolean(),version:z.string(),endpoint_compatible:z.boolean()})}).parse(
      JSON.parse(requireSuccess(await command([join(p.tools,'herdr'),'status','--json'],{env:hostEnvironment({HERDR_ENV:'1',HERDR_SOCKET_PATH:process.env.HERDR_SOCKET_PATH??''})})).toString()));
    if(!server.server.running||server.server.version!=='0.9.1'||!server.server.endpoint_compatible)throw new Error('Run inside a compatible Herdr 0.9.1 session; setup does not replace a running server');
  }
  try{await baseCommit(config);}catch(e){throw new Error(`Set factory.local.json repository/baseRef to an existing Git checkout and commit: ${(e as Error).message}`);}
  if((await git(config.repository,['rev-parse','--show-toplevel'])).toString().trim()!==config.repository)throw new Error('Configure the repository root, rather than a subdirectory; factory init resolves it');
  await modelRuntime(config);
  if(config.telegram&&!process.env[config.telegram.tokenEnv])throw new Error(`Set Telegram credential reference ${config.telegram.tokenEnv}, or remove telegram configuration to disable it`);
  const auth=requireSuccess(await command([join(p.tools,'linear-tui'),'auth','status'])).toString();
  if(auth.includes('Not authenticated')){
    const message=`Linear is not signed in: run ${join(p.tools,'linear-tui')} auth login before planning an issue`;
    if(options.requireLinear??true)throw new Error(message);
    warn(message);
  } else if(config.linear.project)await new Linear(config,root).project();
  console.log(`Doctor passed: pinned tools, private state, repository, host sandbox, model credential reference${auth.includes('Not authenticated')?'':', Linear credentials'}.`);
  return config;
}
