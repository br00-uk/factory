// Serialize dependency maintenance and tests so npm ci cannot replace live VM assets.
import { spawn } from 'node:child_process';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'..');const directory=join(root,'.factory/maintenance');
await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
const holder=spawn('python3',[join(root,'scripts/lock.py'),join(directory,'supervisor.lock')],{stdio:['pipe','pipe','inherit']});
await new Promise((resolve,reject)=>{
  holder.once('error',reject);holder.once('exit',()=>reject(new Error('Setup/check already running')));
  holder.stdout.once('data',data=>data.toString().trim()==='LOCKED'?resolve():reject(new Error('Setup/check already running')));
});
const [exe,...args]=process.argv.slice(2);if(!exe)throw new Error('Command required');
let supervisorHolder;
if(exe==='--supervisor-lock'){
  supervisorHolder=spawn('python3',[join(root,'scripts/lock.py'),join(root,'.factory/supervisor.lock')],{stdio:['pipe','pipe','inherit']});
  await new Promise((resolve,reject)=>{
    supervisorHolder.once('error',reject);supervisorHolder.once('exit',()=>reject(new Error('Stop the factory with make down before setup')));
    supervisorHolder.stdout.once('data',data=>data.toString().trim()==='LOCKED'?resolve():reject(new Error('Stop the factory with make down before setup')));
  }).catch(error=>{holder.stdin.end();throw error;});
}
try{
  const child=exe==='--supervisor-lock'?spawn(args[0],args.slice(1),{cwd:root,stdio:'inherit'}):spawn(exe,args,{cwd:root,stdio:'inherit'});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
  process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
}finally{supervisorHolder?.stdin.end();holder.stdin.end();}
