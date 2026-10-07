import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, paths, configHash } from '../src/config.js';
import { send } from '../src/control.js';
import { fixtureConfig } from './fixtures.js';
import { hostEnvironment } from '../src/safety.js';

test('private supervisor socket rejects invalid authority, refuses a second owner, and shuts down cleanly', {timeout:30000},async()=>{
  const root=await mkdtemp('/tmp/factory-control-');const config=fixtureConfig('/tmp');
  const url=pathToFileURL(join(ROOT,'dist/src/supervisor.js')).href;
  const code=`import {serve} from ${JSON.stringify(url)};await serve(${JSON.stringify(root)},${JSON.stringify(config)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:hostEnvironment(),stdio:['ignore','pipe','pipe']});
  let ready=false;let error='';child.stdout.on('data',data=>{if(data.toString().includes('Factory ready'))ready=true;});
  child.stderr.on('data',data=>{error+=data.toString();});
  const deadline=Date.now()+10000;
  try{
    while(!ready&&child.exitCode===null&&child.signalCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(ready,true,error);
    assert.equal((await lstat(paths(root).state)).mode&0o077,0);assert.equal((await lstat(paths(root).socket)).mode&0o077,0);
    assert.deepEqual(await send({command:'status'},root),[]);
    const health=await send({command:'health'},root) as {configHash:string};
    assert.equal(health.configHash,configHash(config),'Readiness binds the configuration actually loaded by the foreground supervisor');
    const invalid=await new Promise<string>((resolve,reject)=>{
      const socket=connect(paths(root).socket);let value='';
      socket.on('connect',()=>socket.end(JSON.stringify({command:'approve',hostCommand:'touch /tmp/not-allowed'})+'\n'));
      socket.on('data',data=>{value+=data.toString();});socket.on('end',()=>resolve(value));socket.on('error',reject);
    });
    assert.equal(JSON.parse(invalid).ok,false);
    const second=spawn(process.execPath,['--input-type=module','-e',code],{env:hostEnvironment(),stdio:'ignore'});
    const secondCode=await new Promise<number|null>(resolve=>second.once('exit',resolve));assert.notEqual(secondCode,0);
    await send({command:'shutdown'},root);
    await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    assert.equal(child.exitCode,0,error);
    await assert.rejects(lstat(paths(root).socket),{code:'ENOENT'});
  }finally{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
    await rm(root,{recursive:true,force:true});
  }
});
