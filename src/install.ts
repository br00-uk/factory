import { chmod, readFile, copyFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { paths, ConfigSchema, type Config } from './config.js';
import { atomicWrite, command, hash, privateDirectory, requireSuccess } from './safety.js';
import { Workspace, hostRunner, localAvailability } from './host.js';
import { storeSnapshot } from './artifacts.js';

// Herdr is optional (used only by make up inside a Herdr session); linear-tui is
// the read-only issue intake. Both are hash-pinned release binaries.
export const pinnedTools = {
  herdr: {url:'https://github.com/herdrdev/herdr/releases/download/v0.9.1/herdr-macos-aarch64',
    hash:'5fc7a7e7adfaca56fa80aa89dcb025693357268dab8285b9ce2d08a2313c89de',version:'0.9.1'},
  'linear-tui': {url:'https://github.com/k1-c/linear-tui/releases/download/v0.13.0/linear-tui-aarch64-apple-darwin.tar.gz',
    hash:'5902b360341ea02bc71f9de3cfc1294cc4d29c175bf37a990e444db6171e4686',version:'0.13.0'},
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
        const names=requireSuccess(await command(['/usr/bin/tar','-tzf',archive])).toString().trim().split('\n');
        if(names.length!==1 || names[0]!.replace(/^\.\//,'')!=='linear-tui')throw new Error('Unexpected pinned tool archive layout');
        requireSuccess(await command(['/usr/bin/tar','-xzf',archive,'-C',temp,'linear-tui']));
        const file=join(temp,'linear-tui');const stat=await lstat(file);
        if(!stat.isFile() || stat.isSymbolicLink())throw new Error('Unexpected binary type');
        await atomicWrite(destination,await readFile(file));
      } finally {await rm(temp,{recursive:true,force:true});}
    }
    await chmod(destination,0o700);await atomicWrite(marker,hash(await readFile(destination)));
  }
}
/** Prove the OS sandbox on this host with a throwaway workspace: a command runs,
 *  a write outside the workspace is refused, credentials are unreadable, and the
 *  network is unreachable. Records the verified runner in .factory/host.json. */
export async function verifySandbox(config: Config, root: string): Promise<void> {
  const availability=localAvailability();if(!availability.available)throw new Error(`Host sandbox unavailable: ${availability.reason}`);
  const p=paths(root);const outside=join(p.state,`sandbox-probe-${crypto.randomUUID()}`);
  const workspace=await Workspace.create(config,'factory-setup','setup',undefined,root);
  try {
    await workspace.import(await storeSnapshot(p.artifacts,[{path:'probe.txt',mode:'100644',data:Buffer.from('probe\n')}],config.limits));
    const inside=await workspace.execute(['sh','-c','cat probe.txt && echo written > generated.txt']);
    if(inside.code!==0||!inside.stdout.includes('probe'))throw new Error(`Sandboxed command failed: ${inside.stderr.slice(0,500)}`);
    const escape=await workspace.execute(['sh','-c',`echo escaped > '${outside.replaceAll("'","'\\''")}'`]);
    let escaped=false;try{await lstat(outside);escaped=true;}catch{/* refused as required */}
    if(escaped||escape.code===0){await rm(outside,{force:true});throw new Error('Sandbox allowed a write outside the workspace; refusing to proceed');}
    const credentials=[join(homedir(),'.pi/agent/auth.json'),join(homedir(),'.ssh'),join(homedir(),'.aws/credentials')];
    const secret=await workspace.execute(['sh','-c',credentials.map(path=>`test -r '${path}' && echo READABLE '${path}'`).join('; ')]);
    if(secret.stdout.includes('READABLE'))throw new Error(`Sandbox exposed host credentials (${secret.stdout.trim()}); refusing to proceed`);
    const network=await workspace.execute(['sh','-c','curl -s --max-time 5 -o /dev/null https://example.com && echo REACHED || echo denied']);
    if(network.stdout.includes('REACHED'))throw new Error('Sandbox allowed network egress; refusing to proceed');
  } finally { await workspace.close(); }
  await atomicWrite(join(p.state,'host.json'),JSON.stringify({runner:hostRunner(),platform:`${process.platform}-${process.arch}`,verified:new Date().toISOString()}));
}
export async function setup(root: string): Promise<void> {
  if(process.platform!=='darwin' || process.arch!=='arm64')throw new Error('Apple Silicon macOS is required for the pinned tool binaries');
  const p=paths(root);
  for(const directory of [p.state,p.artifacts,p.sessions,p.work,p.cache])await privateDirectory(directory);
  await installTools(root);
  try {await copyFile(join(root,'factory.example.json'),p.config,1);await chmod(p.config,0o600);} catch(e) {if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const config=ConfigSchema.parse(JSON.parse(await readFile(p.config,'utf8')));
  await verifySandbox(config,root);
  console.log(`Setup complete. Run factory init inside the target repository, or configure ${p.config} by hand; then make doctor.`);
}
