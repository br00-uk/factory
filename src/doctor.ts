import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Machine } from 'smolmachines';
import { loadConfig, paths, type Config } from './config.js';
import { baseCommit, git } from './git.js';
import { command, requireSuccess, hash, hostEnvironment, fingerprint } from './safety.js';
import { z } from 'zod';
import { pinnedTools } from './install.js';
import { modelRuntime } from './pi.js';
import { Linear } from './linear.js';
import { unavailableCheck } from './checks.js';

export async function doctor(root:string):Promise<Config> {
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
  if(process.env.HERDR_ENV!=='1')throw new Error('Run make doctor/up from a Herdr pane (HERDR_ENV=1)');
  for(const [name,pin] of Object.entries(pinnedTools)) {
    const binary=join(p.tools,name);const bytes=await readFile(binary);
    if(hash(bytes)!==(await readFile(`${binary}.pin`,'utf8')))throw new Error(`Pinned ${name} binary changed; make setup`);
    if(!requireSuccess(await command([binary,'--version'])).toString().includes(pin.version))throw new Error(`Incorrect ${name} version`);
  }
  const server=z.object({server:z.object({running:z.boolean(),version:z.string(),endpoint_compatible:z.boolean()})}).parse(
    JSON.parse(requireSuccess(await command([join(p.tools,'herdr'),'status','--json'],{env:hostEnvironment({HERDR_ENV:'1',HERDR_SOCKET_PATH:process.env.HERDR_SOCKET_PATH??''})})).toString()));
  if(!server.server.running||server.server.version!=='0.9.1'||!server.server.endpoint_compatible)throw new Error('Run inside a compatible Herdr 0.9.1 session; setup does not replace a running server');
  if(!Machine.localAvailability().available)throw new Error('smol local engine unavailable; no host fallback');
  const image=JSON.parse(await readFile(join(p.state,'image.json'),'utf8')) as {image:string;toolchain?:string};
  if(image.image!==config.environment.image)throw new Error('Image changed/unprepared; run make setup');
  if(config.environment.toolchain&&image.toolchain!==fingerprint(config.environment.toolchain))throw new Error('Toolchain preparation changed/unverified; run make setup');
  try{await baseCommit(config);}catch(e){throw new Error(`Set factory.local.json repository/baseRef to an existing Git checkout and commit: ${(e as Error).message}`);}
  if((await git(config.repository,['rev-parse','--show-toplevel'])).toString().trim()!==config.repository)throw new Error('Configure the repository root, rather than a subdirectory; factory register resolves it');
  await modelRuntime(config);
  if(config.telegram&&!process.env[config.telegram.tokenEnv])throw new Error(`Set Telegram credential reference ${config.telegram.tokenEnv}, or remove telegram configuration to disable it`);
  const auth=requireSuccess(await command([join(p.tools,'linear-tui'),'auth','status'])).toString();
  if(auth.includes('Not authenticated'))throw new Error('Authenticate explicitly with .cache/tools/linear-tui auth login');
  if(config.linear.project)await new Linear(config,root).project();
  console.log('Doctor passed: pinned tools, private state, repository, prepared image, model credential reference, Linear credentials.');
  return config;
}
