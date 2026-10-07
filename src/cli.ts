#!/usr/bin/env node
import { ROOT, loadConfig, paths, ConfigSchema, credentialEnvs } from './config.js';
import { setup } from './install.js';
import { doctor } from './doctor.js';
import { validate } from './validate.js';
import { serve } from './supervisor.js';
import { parseCommand, send } from './control.js';
import { clean } from './safety.js';
import { up, down } from './workspace.js';
import { atomicWrite } from './safety.js';
import { readFile, unlink, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { hostEnvironment } from './safety.js';
import { git } from './git.js';

try {
  process.umask(0o077);
  const [action,...args]=process.argv.slice(2);
  if(action==='setup-integrations')await setup(ROOT);
  else if(action==='doctor')await doctor(ROOT);
  else if(action==='validate')await validate(ROOT);
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
      PI_CODING_AGENT_DIR:join(p.state,'operator'),PI_OFFLINE:'1',PI_TELEMETRY:'0'});
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
    console.log('Repository recorded. Configure its environment/checks, then make doctor.');
  }else console.log(clean(JSON.stringify(await send(parseCommand([action??'status',...args])),null,2)));
}catch(e){console.error(clean((e as Error).message));process.exitCode=1;}
