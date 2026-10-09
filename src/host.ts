import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { ROOT, paths, type Config } from './config.js';
import { atomicWrite, clean, command, hash, inside, privateDirectory, relativePath, requireSuccess } from './safety.js';
import { storeSnapshot, validateManifest, type Snapshot } from './artifacts.js';
import { git } from './git.js';
import type { Store } from './storage.js';

// Every model command and every registered check runs on this host inside an
// OS-level sandbox (Anthropic's sandbox-runtime: Seatbelt on macOS, bubblewrap on
// Linux). The sandbox confines writes to one disposable stage workspace and the
// factory cache, hides credentials and the operator's live checkout from reads,
// and denies all network except an explicit dependency allowlist. This replaced
// the earlier microVM engine; see docs/compatibility.md for the boundary it gives.

export interface HostAvailability { available: boolean; reason?: string }
export function localAvailability(): HostAvailability {
  if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) return { available: false, reason: 'macOS sandbox-exec is missing' };
  } else if (process.platform === 'linux') {
    const missing = ['bwrap', 'socat'].filter(tool => !onPath(tool));
    if (missing.length) return { available: false, reason: `Install ${missing.join(' and ')} for the Linux sandbox` };
  } else return { available: false, reason: `Unsupported host platform ${process.platform}` };
  // The runtime shells out to ripgrep only for its Linux mandatory-deny scan.
  if (process.platform === 'linux' && !onPath('rg')) return { available: false, reason: 'ripgrep (rg) is required by the Linux sandbox runtime' };
  return { available: true };
}
export function onPath(tool: string): boolean {
  return (process.env.PATH ?? '').split(':').some(dir => dir && existsSync(join(dir, tool)));
}
export function hostRunner(): string { return `host:${process.platform}-${process.arch}:sandbox-runtime`; }
export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const SENSITIVE = ['.ssh', '.aws', '.gnupg', '.pi', '.config', '.kube', '.docker', '.netrc', '.gitconfig', '.npmrc', '.zsh_history', '.bash_history',
  'Library/Keychains', 'Library/Application Support', 'Library/Cookies', '.local/share'];
export function cacheDirectory(root = ROOT): string { return join(paths(root).state, 'cache'); }
export function workDirectory(root = ROOT): string { return join(paths(root).state, 'work'); }

let initialized: string | undefined;
export async function initializeSandbox(config: Config, root = ROOT): Promise<void> {
  const availability = localAvailability();
  if (!availability.available) throw new Error(`Host sandbox unavailable: ${availability.reason}; no unsandboxed fallback`);
  // The runtime points TMPDIR at /tmp/claude inside every profile and expects it
  // to exist; workspace commands are re-pointed at their own tmp directory below.
  await mkdir('/tmp/claude', { recursive: true, mode: 0o700 }).catch(() => undefined);
  const key = JSON.stringify(baseSandboxConfig(config, root));
  if (initialized === key) return;
  if (initialized) { await SandboxManager.reset(); }
  await SandboxManager.initialize(baseSandboxConfig(config, root));
  initialized = key;
}
export async function resetSandbox(): Promise<void> { if (initialized) { initialized = undefined; await SandboxManager.reset(); } }
function baseSandboxConfig(config: Config, root: string): SandboxRuntimeConfig {
  const home = homedir();
  const denyRead = [...SENSITIVE.map(name => join(home, name)), paths(root).state, config.repository, ...(config.environment.sandbox?.denyRead ?? [])];
  // Loopback stays usable: test suites start httptest servers and integration
  // tests probe local services, skipping when nothing answers. Everything beyond
  // the loopback interface is denied unless a dependency bootstrap allows a host.
  return {
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
    filesystem: { denyRead, allowRead: [workDirectory(root), cacheDirectory(root), ...(config.environment.sandbox?.allowRead ?? [])], allowWrite: [cacheDirectory(root)], denyWrite: [] },
  } as SandboxRuntimeConfig;
}

export function expandEnvironment(config: Config, root = ROOT): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.environment.env)) expanded[key] = value.replaceAll('${FACTORY_CACHE}', cacheDirectory(root));
  return expanded;
}

export class Workspace {
  private closed = false;
  private closing: Promise<void> | undefined;
  private frozen = false;
  private readonly controller = new AbortController();
  private readonly groups = new Set<number>();
  readonly preparation: { name: string; argv: string[]; code: number; stdout: string; stderr: string }[] = [];
  readonly src: string; readonly home: string; readonly tmp: string;
  get stopped(): boolean { return this.closed || this.controller.signal.aborted; }
  get name(): string { return this.dir; }
  constructor(readonly dir: string, readonly config: Config, private readonly root: string, private readonly store?: Store) {
    this.src = join(dir, 'src'); this.home = join(dir, 'home'); this.tmp = join(dir, 'tmp');
  }
  static async create(config: Config, owner: string, run: string, store?: Store, root = ROOT): Promise<Workspace> {
    await initializeSandbox(config, root);
    await privateDirectory(workDirectory(root)); await privateDirectory(cacheDirectory(root));
    const dir = join(workDirectory(root), `${owner.slice(0, 12)}-${crypto.randomUUID().slice(0, 12)}`);
    // Record identity before creating anything, so recovery can find it after a crash.
    store?.recordWorkspace(run, dir, owner);
    const workspace = new Workspace(dir, config, root, store);
    try {
      for (const directory of [dir, workspace.src, workspace.home, workspace.tmp]) await privateDirectory(directory);
      await atomicWrite(join(dir, 'pids.json'), '[]');
      return workspace;
    } catch (e) { await workspace.close(); throw e; }
  }
  private environment(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: this.home, TMPDIR: this.tmp, LANG: 'C.UTF-8', PYTHONSAFEPATH: '1', FACTORY_CACHE: cacheDirectory(this.root),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(this.dir, 'gitconfig'), GIT_TERMINAL_PROMPT: '0', CI: 'true', ...expandEnvironment(this.config, this.root) };
  }
  private async recordGroup(pgid: number, remove = false): Promise<void> {
    if (remove) this.groups.delete(pgid); else this.groups.add(pgid);
    await atomicWrite(join(this.dir, 'pids.json'), JSON.stringify([...this.groups].map(pid => ({ pid, since: new Date().toISOString() }))));
  }
  /** Run argv inside the sandbox with the workspace source as cwd. Network is
   *  denied unless `allowHosts` names the dependency registries for a bootstrap. */
  async execute(argv: string[], options: { timeout?: number; signal?: AbortSignal; cwd?: string; allowHosts?: string[]; writable?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.stopped) throw new Error('Workspace execution is stopped');
    if (!argv.length || argv.some(a => a.includes('\0')) || argv.length > 64) throw new Error('Invalid command argv');
    const seconds = Math.min(options.timeout ?? this.config.limits.commandSeconds, this.config.limits.commandSeconds);
    const cwd = options.cwd ?? this.src;
    if (!(cwd === this.src || cwd.startsWith(`${this.src}/`) || cwd === this.dir)) throw new Error('Command cwd must be inside the workspace');
    const writable = options.writable ?? !this.frozen;
    const override: Partial<SandboxRuntimeConfig> = {
      network: { allowedDomains: options.allowHosts ?? [], deniedDomains: [], allowLocalBinding: true },
      filesystem: { ...baseSandboxConfig(this.config, this.root).filesystem,
        allowWrite: [cacheDirectory(this.root), this.home, this.tmp, ...(writable ? [this.src] : this.dependencyPaths().map(p => join(this.src, p)))],
        denyWrite: writable ? [] : [join(this.src, '.git')] },
    } as Partial<SandboxRuntimeConfig>;
    // The wrapper prefixes its own `env TMPDIR=/tmp/claude …`; re-point TMPDIR at
    // this workspace's tmp inside the profile so tools never share a temp dir.
    const shell = ['/usr/bin/env', `TMPDIR=${this.tmp}`, ...argv].map(quote).join(' ');
    // The runtime's proxies filter with the process-wide allowlist, so a dependency
    // bootstrap widens it only for the duration of that one command. Workspace
    // commands never overlap within a supervisor, and the base policy is restored
    // in `finally` even when the command fails.
    const base = baseSandboxConfig(this.config, this.root);
    const hosts = options.allowHosts ?? [];
    // macOS TLS verification goes through trustd, which the Seatbelt profile
    // hides; a bootstrap that must fetch over HTTPS gets that one mach service
    // back (the runtime's enableWeakerNetworkIsolation) together with its hosts.
    const bootstrap = hosts.length ? { network: { ...base.network, allowedDomains: hosts }, enableWeakerNetworkIsolation: true } : {};
    if (hosts.length) SandboxManager.updateConfig({ ...base, ...bootstrap } as SandboxRuntimeConfig);
    const wrapped = await SandboxManager.wrapWithSandboxArgv(shell, '/bin/sh', { ...override, ...bootstrap } as Partial<SandboxRuntimeConfig>, options.signal, cwd);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Command timed out')), seconds * 1000);
    const signals = [this.controller.signal, deadline.signal]; if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    let stdout = ''; let stderr = ''; let bytes = 0;
    try {
      const result = await new Promise<{ code: number }>((accept, reject) => {
        // Only the explicit workspace environment reaches the sandbox: the wrapper
        // returns a copy of the host environment, which must never leak credentials.
        const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), { cwd, env: this.environment(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        let failure: Error | undefined; let recorded: Promise<void> | undefined;
        if (child.pid) recorded = this.recordGroup(child.pid);
        const stop = (reason: Error) => { failure ??= reason; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* exit proves termination */ } };
        const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('Command cancelled'));
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        for (const [stream, sink] of [[child.stdout, (d: string) => { stdout += d; }], [child.stderr, (d: string) => { stderr += d; }]] as const) {
          stream.on('data', (data: Buffer) => {
            bytes += data.length;
            if (bytes > this.config.limits.maxOutputBytes) stop(new Error('Command output limit exceeded')); else sink(data.toString());
          });
        }
        child.on('error', e => { failure = e; });
        child.on('close', code => {
          signal.removeEventListener('abort', abort);
          void (recorded ?? Promise.resolve()).then(() => child.pid ? this.recordGroup(child.pid, true) : undefined).catch(() => undefined);
          if (failure) reject(failure); else if (code === null) reject(new Error('Command returned no exit evidence')); else accept({ code });
        });
      });
      return { code: result.code, stdout, stderr };
    } catch (e) {
      // Any uncertain result (timeout, overflow, cancellation) ends the whole workspace.
      await this.close(); throw e;
    } finally { clearTimeout(timer); if (hosts.length) SandboxManager.updateConfig(base); }
  }
  private dependencyPaths(): string[] { return this.config.environment.dependencies?.paths ?? []; }
  async import(snapshot: Snapshot): Promise<void> {
    const generated = this.dependencyPaths();
    if (snapshot.manifest.some(f => generated.some(p => f.path.normalize('NFC').toLowerCase() === p.normalize('NFC').toLowerCase()
      || f.path.normalize('NFC').toLowerCase().startsWith(p.normalize('NFC').toLowerCase() + '/')))) throw new Error('Registered dependency directories overlap tracked source');
    for (const f of snapshot.manifest) {
      const bytes = await readFile(inside(join(snapshot.directory, 'source'), f.path));
      if (bytes.length !== f.size || hash(bytes) !== f.sha256) throw new Error('Source changed during workspace transfer');
      const target = inside(this.src, f.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: f.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
    }
    await writeFile(join(this.dir, 'gitconfig'), '[safe]\n directory = *\n[core]\n hooksPath = /dev/null\n fsmonitor = false\n[credential]\n helper =\n[user]\n name = Local Factory\n email = factory@localhost\n', { mode: 0o600 });
    // A small ordinary Git repository belongs entirely to the workspace. It is built
    // from validated bytes with controlled configuration; host metadata is never copied.
    await git(this.src, ['init', '--quiet', '--initial-branch=factory-base']);
    await git(this.src, ['add', '--all']);
    await git(this.src, ['-c', 'user.name=Local Factory', '-c', 'user.email=factory@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Imported source snapshot']);
  }
  async prepareDependencies(): Promise<void> {
    const profile = this.config.environment.dependencies; if (!profile) return;
    const result = await this.execute(profile.argv, { timeout: profile.timeoutSeconds, allowHosts: profile.allowHosts });
    this.preparation.push({ name: 'dependencies', argv: profile.argv, ...result });
    if (result.code) throw new Error(`dependencies preparation failed (${result.code}): ${clean(result.stderr.slice(0, 2000))}`);
    for (const path of profile.paths) {
      const target = inside(this.src, path);
      try { const stat = await lstat(target); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Dependency path must be a regular directory'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  private async killChildren(): Promise<void> {
    for (const pgid of [...this.groups]) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  /** Stop every workspace process and make tracked source read-only. Registered
   *  dependency directories stay writable for tool caches. The sandbox denies
   *  source writes independently of these permission bits. */
  async freeze(): Promise<void> {
    await this.killChildren();
    this.frozen = true;
    await this.walkSource(async (path, stat) => {
      if (stat.isDirectory()) await chmod(path, 0o555);
      else if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Non-regular source file');
      else await chmod(path, stat.mode & 0o111 ? 0o555 : 0o444);
    });
    await chmod(this.src, 0o555);
  }
  private async thaw(): Promise<void> {
    this.frozen = false;
    try { await chmod(this.src, 0o700); } catch { /* missing */ }
    await this.walkSource(async (path, stat) => {
      if (stat.isDirectory()) await chmod(path, 0o755); else if (stat.isFile()) await chmod(path, stat.mode & 0o111 ? 0o755 : 0o644);
    }, true).catch(() => undefined);
  }
  private async walkSource(visit: (path: string, stat: Stats) => Promise<void>, includeGenerated = false): Promise<void> {
    const generated = new Set(['.git', ...(includeGenerated ? [] : this.dependencyPaths())]);
    const recurse = async (directory: string): Promise<void> => {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name);
        if (generated.has(relative(this.src, path))) continue;
        const stat = await lstat(path);
        if (stat.isDirectory()) { await recurse(path); await visit(path, stat); } else await visit(path, stat);
      }
    };
    await recurse(this.src);
  }
  async export(artifacts: string): Promise<Snapshot> {
    await this.freeze();
    const entries: { path: string; mode: '100644' | '100755'; data: Buffer }[] = []; let total = 0;
    await this.walkSource(async (path, stat) => {
      if (stat.isDirectory()) return;
      if (!stat.isFile()) throw new Error('Non-regular file');
      const rel = relative(this.src, path);
      if (!rel.isWellFormed()) throw new Error('Source paths must have valid UTF-8');
      relativePath(rel);
      total += stat.size;
      if (stat.size > this.config.limits.maxFileBytes || total > this.config.limits.maxArtifactBytes) throw new Error('Artifact size limit');
      entries.push({ path: rel, mode: stat.mode & 0o111 ? '100755' : '100644', data: await readFile(path) });
      if (entries.length > 50000) throw new Error('Artifact file count limit');
    });
    validateManifest(entries.map(e => ({ path: e.path, mode: e.mode, size: e.data.length, sha256: hash(e.data) })).sort((a, b) => a.path.localeCompare(b.path, 'en')), this.config.limits);
    return storeSnapshot(artifacts, entries, this.config.limits);
  }
  /** Make tracked source writable again after an export froze it (implementation
   *  continues or a check writes temporary outputs). Verification freezes it again. */
  async unfreeze(): Promise<void> { await this.thaw(); }
  private async resolveInside(path: string): Promise<string> {
    const target = inside(this.src, path);
    const realSrc = await realpath(this.src);
    const parent = await realpath(dirname(target));
    if (parent !== realSrc && !parent.startsWith(`${realSrc}/`)) throw new Error('Path escapes source');
    try { const stat = await lstat(target); if (stat.isSymbolicLink()) throw new Error('Symlinks are not source'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return target;
  }
  async read(path: string): Promise<string> {
    const target = await this.resolveInside(path);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > this.config.limits.maxFileBytes) throw new Error('Read bound/type');
    return (await readFile(target)).toString('utf8');
  }
  async write(path: string, text: string): Promise<void> {
    if (this.frozen) throw new Error('Source is frozen');
    if (Buffer.byteLength(text) > this.config.limits.maxFileBytes) throw new Error('Write bound exceeded');
    const target = inside(this.src, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await this.resolveInside(path);
    await writeFile(target, text, { mode: 0o644 });
  }
  async inspect(kind: 'list' | 'search', path: string, text = ''): Promise<string> {
    if (path) relativePath(path);
    const start = path ? await this.resolveInside(path) : this.src;
    const out: string[] = []; let size = 0; const limit = this.config.limits.maxOutputBytes;
    const files: string[] = [];
    const stat = await lstat(start).catch(() => undefined);
    if (stat?.isFile()) files.push(start);
    else if (stat?.isDirectory()) {
      const recurse = async (directory: string): Promise<void> => {
        for (const name of (await readdir(directory)).sort()) {
          if (name === '.git' || name === 'node_modules') continue;
          const full = join(directory, name); const s = await lstat(full);
          if (s.isSymbolicLink()) continue;
          if (s.isDirectory()) await recurse(full); else if (s.isFile()) files.push(full);
          if (files.length > 50000) throw new Error('File count bound');
        }
      };
      await recurse(start);
    }
    for (const file of files) {
      const name = relative(this.src, file);
      let lines: string[];
      if (kind === 'list') lines = [name];
      else {
        const s = await lstat(file); if (s.size > this.config.limits.maxFileBytes) continue;
        lines = (await readFile(file, 'utf8')).split('\n').map((line, i) => line.includes(text) ? `${name}:${i + 1}:${line.slice(0, 1000)}` : '').filter(Boolean);
      }
      for (const line of lines) {
        size += Buffer.byteLength(line);
        if (out.length >= 1000 || size > limit) return JSON.stringify(out);
        out.push(line);
      }
    }
    return JSON.stringify(out);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.closing = this.terminate(); return this.closing;
  }
  private async terminate(): Promise<void> {
    this.controller.abort(new Error('Workspace execution is stopped'));
    await this.killChildren();
    await this.thaw();
    await rm(this.dir, { recursive: true, force: true });
    if (existsSync(this.dir)) throw new Error('Workspace deletion could not be confirmed');
    this.closed = true; this.store?.stoppedWorkspace(this.dir);
  }
}
/** Recovery: stop processes a previous supervisor left in its recorded
 *  workspaces, then delete the directories. Only process groups whose start time
 *  follows the recorded time are signalled, so a reused PID is never touched. */
export async function stopRecordedWorkspaces(store: Store, owner: string): Promise<void> {
  for (const workspace of store.unresolvedWorkspaces()) {
    if (workspace.owner !== owner) throw new Error(`Recorded workspace ${workspace.name} belongs to another owner; refusing to touch it`);
    const file = join(workspace.name, 'pids.json');
    let pids: { pid: number; since: string }[] = [];
    try { pids = JSON.parse(await readFile(file, 'utf8')) as { pid: number; since: string }[]; } catch { /* nothing recorded */ }
    for (const { pid, since } of pids) {
      if (!Number.isInteger(pid) || pid <= 1) continue;
      let started: string;
      try { started = requireSuccess(await command(['/bin/ps', '-o', 'lstart=', '-p', String(pid)])).toString().trim(); } catch { continue; }
      if (!started || Date.parse(started) < Date.parse(since) - 1000) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    if (existsSync(workspace.name)) {
      await command(['/bin/chmod', '-R', 'u+rwX', workspace.name]).catch(() => undefined);
      await rm(workspace.name, { recursive: true, force: true });
    }
    if (existsSync(workspace.name)) throw new Error(`Workspace ${workspace.name} could not be removed; execution stays blocked`);
    store.stoppedWorkspace(workspace.name);
  }
}
export function resolveWorkspacePath(root: string, path: string): string { return resolve(workDirectory(root), path); }
