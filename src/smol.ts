import { Machine } from 'smolmachines';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT,paths,type Config } from './config.js';
import { hash, inside, relativePath, command, hostEnvironment, requireSuccess } from './safety.js';
import { storeSnapshot, validateManifest, type Snapshot } from './artifacts.js';
import type { Store } from './storage.js';

export const REGISTRIES = ['index.docker.io','registry-1.docker.io','auth.docker.io',
  'production.cloudflare.docker.com','production.cloudfront.docker.com',
  'public.ecr.aws','d2glxqk2uabbnd.cloudfront.net'];
export const LOCAL = { target: 'local', handleSignals: false } as const;
export async function deleteLocalMachine(name:string,root=ROOT):Promise<void> {
  // SDK connect() is start-or-reconnect. Recovery must not boot interrupted
  // source just to acquire a handle. The pinned CLI deletes a local record
  // directly, including stopped or damaged disks, without starting the guest.
  if(!/^factory-[a-zA-Z0-9-]+$/.test(name))throw new Error('Invalid factory VM identity');
  const binary=join(paths(root).tools,'smol');
  try{
    if(hash(await readFile(binary))!==(await readFile(`${binary}.pin`,'utf8')))throw new Error('Pinned smol CLI changed');
  }catch(e){throw new Error(`Local deletion CLI unavailable/unverified; run make setup: ${(e as Error).message}`);}
  let failure:unknown;
  try{requireSuccess(await command([binary,'machine','rm','--local','--name',name,'--yes'],
    {env:hostEnvironment(),timeoutMs:8000,maxBytes:128*1024}));}catch(e){failure=e;}
  if((await Machine.list(LOCAL)).some(m=>m.name===name)){
    if(failure)throw failure;throw new Error('VM deletion could not be confirmed');
  }
}
export class Guest {
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly controller = new AbortController();
  readonly preparation:{name:string;argv:string[];code:number;stdout:string;stderr:string}[]=[];
  get stopped():boolean{return this.closed||this.controller.signal.aborted;}
  constructor(readonly machine: Machine, readonly config: Config, private readonly store?: Store) {}
  static async create(config: Config, owner: string, run: string, store?: Store): Promise<Guest> {
    const name = `factory-${owner.slice(0,12)}-${crypto.randomUUID().slice(0,12)}`;
    // Record identity before provisioning, including failures partway through create().
    store?.recordVM(run, name, owner);
    const machine = await Machine.create({ name, image: config.environment.image,
      mounts: [], ports: [], resources: { cpus: config.limits.cpus, memoryMb: config.limits.memoryMb,
        storageGb: config.limits.diskGb, overlayGb: config.limits.diskGb,
        network: true, allowHosts: REGISTRIES, networkBackend: 'virtio-net' },
      persistent: true, detach: false, labels: { owner, run } }, LOCAL);
    const guest = new Guest(machine, config, store);
    try {
      // Image preparation has no source, credentials or model activity. Before transfer,
      // stop and deny all networking on the host-side backend, then boot the clean image.
      await machine.stop(); await machine.setNetworkPolicy('deny-all'); await machine.start();
      await guest.root(['python3','-I','-S','-c','import os\nfor p in ["/workspace","/var/cache/factory"]: os.makedirs(p,exist_ok=True); os.chown(p,1000,1000)']);
      await guest.root(['python3','-I','-S','-c','import os;os.makedirs("/factory",mode=0o700,exist_ok=True)']);
      await machine.writeFile('/factory/prepare-toolchain.py',await readFile(join(ROOT,'scripts/prepare-toolchain.py')),0o500);
      await machine.writeFile('/etc/factory-gitconfig',Buffer.from('[safe]\n directory = /workspace\n[core]\n hooksPath = /dev/null\n fsmonitor = false\n[credential]\n helper =\n'),0o444);
      if(config.environment.toolchain)await guest.bootstrap('toolchain',config.environment.toolchain,'0:0','/');
      return guest;
    } catch (e) { await guest.close(); throw e; }
  }
  async execute(argv: string[], options: { timeout?: number; signal?: AbortSignal; user?: string; cwd?: string } = {}): Promise<{code:number;stdout:string;stderr:string}> {
    if (this.closed || this.controller.signal.aborted) throw new Error('Guest execution is stopped');
    if (!argv.length || argv.some(a => a.includes('\0')) || argv.length > 64) throw new Error('Invalid guest argv');
    const seconds=Math.min(options.timeout??this.config.limits.commandSeconds,this.config.limits.commandSeconds);
    const deadline=new AbortController();
    const timer=setTimeout(()=>deadline.abort(new Error('Guest command timed out')),seconds*1000);
    const signals = [this.controller.signal,deadline.signal]; if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals); let stdout = ''; let stderr = ''; let bytes = 0; let code: number | undefined;
    try {
      for await (const event of this.machine.execStream(argv, { user: options.user ?? '1000:1000',
        // The host deadline acts first; an engine-only timeout can return an exit
        // event while descendants or the VM survive. Abort closes the whole VM.
        workdir: options.cwd ?? '/workspace', timeout: seconds+1,
        env: { HOME:'/tmp', PATH:'/usr/local/bin:/usr/bin:/bin', LANG:'C.UTF-8', PYTHONSAFEPATH:'1',
          GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/etc/factory-gitconfig',
          ...(options.user==='0:0'?{}:this.config.environment.env) }, signal })) {
        if (event.kind === 'stdout' || event.kind === 'stderr') {
          bytes += Buffer.byteLength(event.data);
          if (bytes > this.config.limits.maxOutputBytes) throw new Error('Guest output limit exceeded');
          if (event.kind === 'stdout') stdout += event.data; else stderr += event.data;
        } else if (event.kind === 'exit') code = event.exitCode;
        else throw new Error(`Guest infrastructure failure: ${event.message}`);
      }
      signal.throwIfAborted();
      if (code === undefined) throw new Error('Guest command returned no exit evidence');
      return {code,stdout,stderr};
    } catch (e) {
      // Any uncertain command result ends the whole VM, including descendants.
      await this.close(); throw e;
    }finally{clearTimeout(timer);}
  }
  async root(argv: string[]): Promise<{code:number;stdout:string;stderr:string}> {
    const result = await this.execute(argv, {user:'0:0',cwd:'/'});
    if (result.code) throw new Error(`Trusted guest helper failed (${result.code}): ${result.stderr.slice(0,1000)}`);
    return result;
  }
  async import(snapshot: Snapshot): Promise<void> {
    const generated=this.config.environment.dependencies?.paths??[];
    if(snapshot.manifest.some(f=>generated.some(p=>f.path.normalize('NFC').toLowerCase()===p.normalize('NFC').toLowerCase()
      ||f.path.normalize('NFC').toLowerCase().startsWith(p.normalize('NFC').toLowerCase()+'/'))))throw new Error('Registered dependency directories overlap tracked source');
    const directories = [...new Set(snapshot.manifest.map(f => `/workspace/${relativePath(f.path).split('/').slice(0,-1).join('/')}`))];
    await this.root(['python3','-I','-S','-c','import os,json,sys\nfor p in json.loads(sys.argv[1]): os.makedirs(p,exist_ok=True)',JSON.stringify(directories)]);
    for (const f of snapshot.manifest) {
      const bytes = await readFile(inside(join(snapshot.directory,'source'),f.path));
      if (bytes.length !== f.size || hash(bytes) !== f.sha256) throw new Error('Source changed during VM transfer');
      await this.machine.writeFile(`/workspace/${f.path}`, bytes, Number.parseInt(f.mode.slice(3),8));
    }
    await this.root(['python3','-I','-S','-c','import os\nfor d,ds,fs in os.walk("/workspace"):\n os.chown(d,1000,1000)\n for f in fs: os.chown(os.path.join(d,f),1000,1000)']);
    // A small ordinary Git repository belongs entirely to the guest. Construct
    // its objects/index from validated bytes; never transfer shared host metadata
    // or depend on checkout filters, hooks, or a Git binary in the helper image.
    await this.root(['python3','-I','-S','-c',`import os,sys,json,hashlib,zlib,struct
root='/workspace/.git';os.makedirs(root+'/objects',exist_ok=True);os.makedirs(root+'/refs/heads',exist_ok=True)
def obj(kind,data):
 raw=(kind+' '+str(len(data))+'\\0').encode()+data; h=hashlib.sha1(raw).hexdigest()
 os.makedirs(root+'/objects/'+h[:2],exist_ok=True);open(root+'/objects/'+h[:2]+'/'+h[2:],'wb').write(zlib.compress(raw));return bytes.fromhex(h)
tree={};entries=[]
for f in json.loads(sys.argv[1]):
 name=f['path'].encode();data=open('/workspace/'+f['path'],'rb').read();blob=obj('blob',data)
 node=tree;parts=f['path'].split('/')
 for part in parts[:-1]: node=node.setdefault(part,{})
 node[parts[-1]]=(f['mode'],blob)
 e=struct.pack('!10I20sH',0,0,0,0,0,0,int(f['mode'],8),0,0,len(data),blob,min(len(name),4095))+name+b'\\0'
 entries.append((name,e+b'\\0'*(-len(e)%8)))
def write_tree(node):
 rows=[]
 for name,value in node.items():
  directory=isinstance(value,dict);mode,blob=('40000',write_tree(value)) if directory else value
  rows.append((name.encode()+(b'/' if directory else b''),mode.encode()+b' '+name.encode()+b'\\0'+blob))
 return obj('tree',b''.join(row for _,row in sorted(rows)))
t=write_tree(tree).hex();commit=obj('commit',('tree '+t+'\\nauthor Local Factory <factory@localhost> 0 +0000\\ncommitter Local Factory <factory@localhost> 0 +0000\\n\\nImported source snapshot\\n').encode()).hex()
index=b'DIRC'+struct.pack('!II',2,len(entries))+b''.join(e for _,e in sorted(entries));open(root+'/index','wb').write(index+hashlib.sha1(index).digest())
open(root+'/HEAD','w').write('ref: refs/heads/factory-base\\n');open(root+'/refs/heads/factory-base','w').write(commit+'\\n')
open(root+'/config','w').write('[core]\\n repositoryformatversion = 0\\n bare = false\\n hooksPath = /dev/null\\n fsmonitor = false\\n[credential]\\n helper =\\n[user]\\n name = Local Factory\\n email = factory@localhost\\n')
for d,ds,fs in os.walk(root):
 os.chown(d,1000,1000)
 for f in fs: os.chown(os.path.join(d,f),1000,1000)`,JSON.stringify(snapshot.manifest)]);
  }
  private async bootstrap(name:string,profile:NonNullable<Config['environment']['toolchain']>,user:string,cwd:string):Promise<void>{
    try{
      await this.machine.stop();await this.machine.setNetworkPolicy({allowHosts:profile.allowHosts});await this.machine.start();
      const result=await this.execute(profile.argv,{user,cwd,timeout:profile.timeoutSeconds});
      this.preparation.push({name,argv:profile.argv,...result});
      if(result.code)throw new Error(`${name} preparation failed (${result.code}): ${result.stderr.slice(0,2000)}`);
      // Kill all unprivileged bootstrap descendants before locking execution
      // egress. No model session or verification runs until the reboot completes.
      await this.machine.stop();await this.machine.setNetworkPolicy('deny-all');await this.machine.start();
    }catch(e){await this.close();throw e;}
  }
  async prepareDependencies():Promise<void>{
    const profile=this.config.environment.dependencies;if(!profile)return;
    await this.bootstrap('dependencies',profile,'1000:1000','/workspace');
    const script=`import os,sys,json,stat
for path in json.loads(sys.argv[1]):
 p='/workspace/'+path
 if os.path.lexists(p) and (os.path.islink(p) or not os.path.isdir(p)): raise RuntimeError('Dependency path must be a regular directory')`;
    await this.root(['python3','-I','-S','-c',script,JSON.stringify(profile.paths)]);
  }
  async freeze(): Promise<void> {
    await this.root(['python3','-I','-S','-c',`import os,signal,stat
for p in os.listdir('/proc'):
 if p.isdigit():
  try:
   if os.stat('/proc/'+p).st_uid==1000: os.kill(int(p),signal.SIGKILL)
  except ProcessLookupError: pass
for d,ds,fs in os.walk('/workspace',followlinks=False):
 os.chown(d,0,0); os.chmod(d,0o555)
 for n in ds[:]:
  p=os.path.join(d,n)
  if os.path.relpath(p,'/workspace') in ${JSON.stringify(this.config.environment.dependencies?.paths??[])}:
   if os.path.islink(p) or not os.path.isdir(p): raise RuntimeError('Dependency path must remain a regular directory')
   ds.remove(n)
 for f in fs:
  p=os.path.join(d,f); s=os.lstat(p)
  if stat.S_ISLNK(s.st_mode):
   raise RuntimeError('Non-regular source file')
  if not stat.S_ISREG(s.st_mode): raise RuntimeError('Non-regular source file')
  os.chown(p,0,0); os.chmod(p,0o555 if s.st_mode & 0o111 else 0o444)`]);
  }
  async export(artifacts: string): Promise<Snapshot> {
    await this.freeze();
    const script = `import os,stat,json,hashlib
files=[]; total=0
for d,ds,fs in os.walk('/workspace',followlinks=False):
 ds[:]=[n for n in ds if os.path.relpath(os.path.join(d,n),'/workspace') not in ${JSON.stringify(['.git',...(this.config.environment.dependencies?.paths??[])])}]
 for n in ds:
  if os.path.islink(os.path.join(d,n)): raise RuntimeError('Symlink directory')
 for n in fs:
  p=os.path.join(d,n); s=os.lstat(p)
  if not stat.S_ISREG(s.st_mode): raise RuntimeError('Non-regular file')
  total+=s.st_size
  if s.st_size>${this.config.limits.maxFileBytes} or total>${this.config.limits.maxArtifactBytes}: raise RuntimeError('Artifact size limit')
  files.append(dict(path=os.path.relpath(p,'/workspace'),mode='100755' if s.st_mode&0o111 else '100644',size=s.st_size,sha256=hashlib.sha256(open(p,'rb').read()).hexdigest()))
  if len(files)>50000: raise RuntimeError('Artifact file count limit')
print(json.dumps(files))`;
    const manifest = validateManifest(JSON.parse((await this.root(['python3','-I','-S','-c',script])).stdout),this.config.limits);
    const entries: {path:string;mode:'100644'|'100755';data:Buffer}[] = [];
    for (const f of manifest) {
      const bytes = await this.machine.readFile(`/workspace/${f.path}`);
      if (bytes.length !== f.size || hash(bytes) !== f.sha256) throw new Error('Guest artifact transfer integrity failure');
      entries.push({path:f.path,mode:f.mode,data:bytes});
    }
    return storeSnapshot(artifacts,entries,this.config.limits);
  }
  async read(path: string): Promise<string> {
    relativePath(path);
    const script = 'import os,sys,stat\np=os.path.realpath("/workspace/"+sys.argv[1])\nif not p.startswith("/workspace/"): raise RuntimeError("Path escapes source")\ns=os.stat(p)\nif not stat.S_ISREG(s.st_mode) or s.st_size>int(sys.argv[2]): raise RuntimeError("Read bound/type")\nprint(open(p,encoding="utf-8",errors="replace").read())';
    const result = await this.execute(['python3','-I','-S','-c',script,path,String(this.config.limits.maxFileBytes)]);
    if (result.code) throw new Error(result.stderr); return result.stdout;
  }
  async write(path: string, text: string): Promise<void> {
    relativePath(path);
    if (Buffer.byteLength(text)>this.config.limits.maxFileBytes) throw new Error('Write bound exceeded');
    const script = 'import os,sys\np=os.path.realpath("/workspace/"+sys.argv[1])\nif not p.startswith("/workspace/"): raise RuntimeError("Path escapes source")\nos.makedirs(os.path.dirname(p),exist_ok=True)\nopen(p,"w").write(sys.argv[2])';
    const result = await this.execute(['python3','-I','-S','-c',script,path,text]);
    if (result.code) throw new Error(result.stderr);
  }
  async inspect(kind:'list'|'search',path:string,text=''):Promise<string>{
    if(path)relativePath(path);
    const script=`import os,sys,stat,json
p=os.path.realpath('/workspace/'+sys.argv[1])
if p!='/workspace' and not p.startswith('/workspace/'): raise RuntimeError('Path escapes source')
paths=[]
if os.path.isfile(p): paths=[p]
else:
 for d,ds,fs in os.walk(p,followlinks=False):
  ds[:]=sorted(n for n in ds if n not in ['.git','node_modules'] and not os.path.islink(os.path.join(d,n)))
  paths.extend(os.path.join(d,n) for n in sorted(fs))
  if len(paths)>50000: raise RuntimeError('File count bound')
out=[]; size=0
for f in paths:
 s=os.lstat(f)
 if not stat.S_ISREG(s.st_mode): continue
 name=os.path.relpath(f,'/workspace')
 if sys.argv[2]=='list': lines=[name]
 elif s.st_size<=int(sys.argv[4]):
  lines=[name+':'+str(i)+':'+line[:1000] for i,line in enumerate(open(f,encoding='utf-8',errors='replace'),1) if sys.argv[3] in line]
 else: continue
 for line in lines:
  size+=len(line.encode('utf-8'))
  if len(out)>=1000 or size>int(sys.argv[5]): print(json.dumps(out)); sys.exit(0)
  out.append(line)
print(json.dumps(out))`;
    const result=await this.execute(['python3','-I','-S','-c',script,path,kind,text,String(this.config.limits.maxFileBytes),String(Math.floor(this.config.limits.maxOutputBytes/4))]);
    if(result.code)throw new Error(result.stderr);return result.stdout;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if(this.closing)return this.closing;
    this.closing=this.terminate();return this.closing;
  }
  private async terminate():Promise<void> {
    this.controller.abort();
    await this.machine.delete();
    if ((await Machine.list(LOCAL)).some(m => m.name === this.machine.name)) throw new Error('VM deletion could not be confirmed');
    this.closed = true; this.store?.stoppedVM(this.machine.name);
  }
}
export async function stopRecordedVMs(store: Store, owner: string): Promise<void> {
  const machines = await Machine.list(LOCAL);
  for (const vm of store.unresolvedVMs()) {
    if (vm.owner !== owner) throw new Error('Recorded VM ownership does not match installation');
    let found = machines.find(m => m.name === vm.name);
    if (found && (found.labels.owner !== owner || found.labels.run !== vm.run)) throw new Error('VM ownership uncertain; execution blocked');
    // The parent-death reaper may still be shutting down its agent. Wait on
    // observed engine state before deleting the record, rather than racing its
    // filesystem-sync handshake. This never reconnects or boots the guest.
    if(found&&!found.detached&&found.state!=='stopped'){
      const deadline=Date.now()+5000;
      while(found&&found.state!=='stopped'&&Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,100));
        found=(await Machine.list(LOCAL)).find(m=>m.name===vm.name);
        if(found&&(found.labels.owner!==owner||found.labels.run!==vm.run))throw new Error('VM ownership changed; execution blocked');
      }
    }
    if (found) await deleteLocalMachine(vm.name);
    if ((await Machine.list(LOCAL)).some(m => m.name === vm.name)) throw new Error('Old VM still exists; execution blocked');
    store.stoppedVM(vm.name);
  }
  // A crash between create and DB commit cannot escape cleanup: identity is stored first.
  const unrecorded = (await Machine.list(LOCAL)).filter(m => m.labels.owner === owner);
  if (unrecorded.length) throw new Error('Unrecorded factory VM found; inspect ownership before continuing');
}
