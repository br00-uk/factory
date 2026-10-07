import { chmod, readFile, copyFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Machine } from 'smolmachines';
import { DEFAULT_IMAGE, paths, ConfigSchema, type Config } from './config.js';
import { atomicWrite, command, hash, fingerprint, privateDirectory, requireSuccess } from './safety.js';
import { Guest, LOCAL, deleteLocalMachine } from './smol.js';
import { baseCommit,snapshotRepository } from './git.js';

export const pinnedTools = {
  herdr: {url:'https://github.com/herdrdev/herdr/releases/download/v0.9.1/herdr-macos-aarch64',
    hash:'5fc7a7e7adfaca56fa80aa89dcb025693357268dab8285b9ce2d08a2313c89de',version:'0.9.1'},
  'linear-tui': {url:'https://github.com/k1-c/linear-tui/releases/download/v0.13.0/linear-tui-aarch64-apple-darwin.tar.gz',
    hash:'5902b360341ea02bc71f9de3cfc1294cc4d29c175bf37a990e444db6171e4686',version:'0.13.0'},
  smol:{url:'https://github.com/smol-machines/smol/releases/download/v1.22.2/smol-1.22.2-darwin-arm64.tar.gz',
    hash:'9e60f7100e28a992bac5db9282d0e019757e5229ab5946db770c98f2bcc48efe',version:'1.22.2'},
} as const;
export async function download(url: string, expected: string): Promise<Buffer> {
  const response = await fetch(url,{signal:AbortSignal.timeout(60_000)});
  if(!response.ok || !response.body) throw new Error(`Pinned artifact download failed (${response.status})`);
  const chunks:Uint8Array[]=[];let bytes=0;
  for await(const chunk of response.body) {bytes+=chunk.length;if(bytes>128*1024*1024)throw new Error('Download size bound exceeded');chunks.push(chunk);}
  const data=Buffer.concat(chunks);
  if(hash(data)!==expected)throw new Error('Pinned artifact hash mismatch');return data;
}
export async function installTools(root: string): Promise<void> {
  const directory=paths(root).tools;await privateDirectory(directory);
  for(const [name,pin] of Object.entries(pinnedTools)) {
    const destination=join(directory,name);
    const marker=join(directory,`${name}.pin`);
    try {
      if((await readFile(marker,'utf8'))===hash(await readFile(destination))) {
        const result=await command([destination,'--version']);
        if(requireSuccess(result).toString().includes(pin.version)) continue;
      }
    } catch { /* install missing/unvalidated local artifact */ }
    const data=await download(pin.url,pin.hash);
    if(name==='herdr') await atomicWrite(destination,data);
    else {
      const temp=await mkdtemp(join(tmpdir(),'factory-tool-'));
      try {
        const archive=join(temp,'tool.tar.gz');await atomicWrite(archive,data);
        const entry=name==='smol'?'smol-1.22.2-darwin-arm64/smol-bin':'linear-tui';
        const names=requireSuccess(await command(['/usr/bin/tar','-tzf',archive,...(name==='smol'?[entry]:[])])).toString().trim().split('\n');
        if(names.length!==1 || names[0]!.replace(/^\.\//,'')!==entry)throw new Error('Unexpected pinned tool archive layout');
        // The smol CLI is used only for local record deletion, which needs no
        // boot/runtime bundle. Never extract its guest rootfs onto the host.
        requireSuccess(await command(['/usr/bin/tar','-xzf',archive,'-C',temp,entry]));
        const file=join(temp,entry);const stat=await lstat(file);
        if(!stat.isFile() || stat.isSymbolicLink())throw new Error('Unexpected binary type');
        await atomicWrite(destination,await readFile(file));
      } finally {await rm(temp,{recursive:true,force:true});}
    }
    await chmod(destination,0o700);await atomicWrite(marker,hash(await readFile(destination)));
  }
}
export async function setup(root: string): Promise<void> {
  if(process.platform!=='darwin' || process.arch!=='arm64')throw new Error('Apple Silicon macOS is required');
  const p=paths(root);await privateDirectory(p.state);await privateDirectory(p.artifacts);await privateDirectory(p.sessions);
  await installTools(root);
  try {await copyFile(join(root,'factory.example.json'),p.config,1);await chmod(p.config,0o600);} catch(e) {if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const config=ConfigSchema.parse(JSON.parse(await readFile(p.config,'utf8')));
  const available=Machine.localAvailability();if(!available.available)throw new Error(`Local smol unavailable: ${JSON.stringify(available)}`);
  const image=config.environment.image || DEFAULT_IMAGE;
  const owner=`factory-setup-${fingerprint(root).slice(0,16)}`;
  for(const machine of await Machine.list(LOCAL,{labels:{owner}})) {
    if(machine.labels.owner!==owner)throw new Error('Setup VM ownership uncertain');
    await deleteLocalMachine(machine.name,root);
  }
  const guest=await Guest.create(config,owner,'image');
  try {
    const result=await guest.execute(['python3','-I','-S','-c','import sys,platform;print(sys.version);print(platform.machine())']);
    if(result.code!==0)throw new Error('Guest image lacks the required Python helper runtime');
    let source:string|undefined;
    if(config.environment.dependencies){
      const snapshot=await snapshotRepository(config,await baseCommit(config),p.artifacts);source=snapshot.hash;
      await guest.import(snapshot);await guest.prepareDependencies();
      if((await guest.export(p.artifacts)).hash!==source)throw new Error('Dependency preparation changed tracked source');
    }
    await atomicWrite(join(p.state,'image.json'),JSON.stringify({image,toolchain:fingerprint(config.environment.toolchain??null),source,
      verified:new Date().toISOString(),smol:'1.22.2',platform:'linux/arm64'}));
  } finally {await guest.close();}
  console.log(`Setup complete. Configure ${p.config}, model credential reference, and Linear authentication; then make doctor.`);
}
