#!/usr/bin/env node
import { ROOT, loadConfig, paths, ConfigSchema, credentialEnvs } from './config.js';
import { setup } from './install.js';
import { doctor } from './doctor.js';
import { validate } from './validate.js';
import { init, type InitOptions } from './init.js';
import { serve } from './supervisor.js';
import { parseCommand, send } from './control.js';
import { clean } from './safety.js';
import { up, down } from './workspace.js';
import { atomicWrite } from './safety.js';
import { readFile, unlink, lstat, realpath, mkdir, symlink, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { hostEnvironment } from './safety.js';
import { git } from './git.js';

function flag(args:string[],name:string):string|undefined{const index=args.indexOf(`--${name}`);return index>=0?args[index+1]:undefined;}
function has(args:string[],name:string):boolean{return args.includes(`--${name}`);}
async function installLinks():Promise<void>{
  // Make /factory and /factory-init available in every Pi session, and `factory`
  // on PATH. Symlinks point into this checkout; nothing is copied or modified.
  const extensions=join(homedir(),'.pi/agent/extensions');await mkdir(extensions,{recursive:true,mode:0o700});
  const link=join(extensions,'factory');const target=join(ROOT,'pi-extension');
  try{const current=await readlink(link);if(current!==target){await rm(link,{force:true});await symlink(target,link);}}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')await symlink(target,link);else throw new Error(`${link} exists and is not a factory link; remove it first`);}
  const bin=join(homedir(),'.local/bin');await mkdir(bin,{recursive:true});
  const cli=join(bin,'factory');const script=join(ROOT,'bin/factory');
  try{const current=await readlink(cli);if(current!==script){await rm(cli,{force:true});await symlink(script,cli);}}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')await symlink(script,cli);else throw new Error(`${cli} exists and is not a factory link; remove it first`);}
  const onPath=(process.env.PATH??'').split(':').includes(bin);
  console.log(`Installed: ${link} -> ${target}\nInstalled: ${cli} -> ${script}${onPath?'':`\nAdd ${bin} to PATH to run factory directly.`}\nIn any repository: pi, then /factory-init.`);
}
try {
  process.umask(0o077);
  const [action,...args]=process.argv.slice(2);
  if(action==='setup-integrations')await setup(ROOT);
  else if(action==='doctor')await doctor(ROOT,{...(has(args,'no-herdr')?{herdr:false}:{}),...(has(args,'no-linear')?{requireLinear:false}:{})});
  else if(action==='validate')await validate(ROOT);
  else if(action==='install')await installLinks();
  else if(action==='init'){
    const positional=args.filter((a,i)=>!a.startsWith('--')&&!(i>0&&args[i-1]!.startsWith('--')&&!['no-validate','no-start','json'].includes(args[i-1]!.slice(2))));
    const org=flag(args,'org');const team=flag(args,'team');const model=flag(args,'model');const repository=positional[0];
    const options:InitOptions={validate:!has(args,'no-validate'),start:!has(args,'no-start')};
    if(repository)options.repository=repository;if(org)options.organization=org;if(team)options.team=team;if(model)options.model=model;
    if(flag(args,'project-name')&&flag(args,'project-url'))options.project={name:flag(args,'project-name')!,url:flag(args,'project-url')!};
    const json=has(args,'json');const lines:string[]=[];
    options.log=line=>{if(json)lines.push(line);else console.log(clean(line));};
    const result=await init(ROOT,options);
    if(json)console.log(clean(JSON.stringify({...result,log:lines},null,2)));
    else{
      console.log(`\nRegistered ${result.repository} (base ${result.baseRef}); checks: ${result.checks.join(', ')}.`);
      console.log(`Validation: ${result.validated}. Supervisor: ${result.supervisor}.`);
      for(const warning of result.warnings)console.log(`Warning: ${clean(warning)}`);
      console.log(`Next: ${result.next.join('  ·  ')}`);
    }
    if(result.validated==='failed')process.exitCode=1;
  }
  else if(action==='up')await up(ROOT);
  else if(action==='down')await down(ROOT);
  else if(action==='serve'){
    const config=await loadConfig(ROOT);
    if(args[0]==='--handoff'){
      if(!/^[a-f0-9-]{36}$/.test(args[1]??''))throw new Error('Invalid credential handoff');
      const file=join(paths(ROOT).state,`handoff-${args[1]}.json`);const stat=await lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>65536)throw new Error('Unsafe credential handoff');
      const credentials=JSON.parse(await readFile(file,'utf8')) as Record<string,unknown>;await unlink(file);
      const names=credentialEnvs(config);
      if(Object.keys(credentials).some(name=>!names.includes(name)))throw new Error('Credential reference mismatch');
      for(const name of names){const value=credentials[name];if(typeof value!=='string')throw new Error('Missing credential handoff');process.env[name]=value;}
    }
    await serve(ROOT,config);
  }else if(action==='linear-ui'||action==='operator-ui'){
    const config=await loadConfig(ROOT);const p=paths(ROOT);
    const context=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>key.startsWith('HERDR_')&&value!==undefined)) as Record<string,string>;
    const argv=action==='linear-ui'?[join(p.tools,'linear-tui')]:[process.execPath,join(ROOT,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
      '--no-tools','--no-mcp','--no-extensions','--no-context-files','--no-skills','--no-prompt-templates','--no-themes','--no-approve','--offline',
      '-e',join(ROOT,'pi-extension/index.ts'),'--name','Factory','--session-dir',join(p.sessions,'operator')];
    const env=hostEnvironment({...context,TERM:process.env.TERM??'xterm-256color',LINEAR_TUI_STATE_DIR:join(p.state,'linear'),
      PI_CODING_AGENT_DIR:join(p.state,'operator'),PI_OFFLINE:'1',PI_TELEMETRY:'0',FACTORY_OPERATOR:'1'});
    const child=spawn(argv[0]!,argv.slice(1),{cwd:action==='linear-ui'?config.repository:ROOT,env,stdio:'inherit'});
    child.on('error',e=>{console.error(clean(e.message));process.exitCode=1;});
    child.on('exit',code=>{process.exitCode=code??1;});
  }
  else if(action==='register'){
    if(!args[0])throw new Error('Repository path required');
    const config=ConfigSchema.parse(JSON.parse(await readFile(paths(ROOT).config,'utf8')));
    if(!args[0].startsWith('/'))throw new Error('Use an absolute repository path');
    const repository=await realpath(args[0]);
    config.repository=(await git(repository,['rev-parse','--show-toplevel'])).toString().trim();
    await atomicWrite(paths(ROOT).config,JSON.stringify(config,null,2));
    console.log('Repository recorded. Configure its environment/checks (or run factory init to detect them), then make doctor.');
  }else{
    try{console.log(clean(JSON.stringify(await send(parseCommand([action??'status',...args])),null,2)));}
    catch(e){
      const message=(e as Error).message;
      if(/ENOENT|ECONNREFUSED/.test(message))throw new Error(`The factory supervisor is not running (no control socket at ${paths(ROOT).socket}). Start it with factory up, or /factory-init from a Pi session inside the repository.`);
      throw e;
    }
  }
}catch(e){console.error(clean((e as Error).message));process.exitCode=1;}
