import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, chmod, lstat, writeFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export function hash(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
export function fingerprint(value: unknown): string { return hash(JSON.stringify(value)); }
const protectedSecrets=new Set<string>();
export function protectSecret(secret:string):void{if(secret)protectedSecrets.add(secret);}
export function clean(text: string, secrets: string[] = []): string {
  // Strip complete control sequences first, then stray control bytes.
  let value = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
  for (const secret of [...protectedSecrets,...secrets].filter(Boolean)) value = value.split(secret).join('[redacted]');
  return value;
}
export function relativePath(path: string): string {
  if (!path || !path.isWellFormed() || isAbsolute(path) || path.includes('\\') || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(path)
      || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new Error(`Unsafe source path: ${clean(path)}`);
  }
  return path;
}
export function inside(root: string, path: string): string {
  return resolve(root, relativePath(path));
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a private directory: ${path}`);
  await chmod(path, 0o700);
}
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await privateDirectory(dirname(path));
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
export function hostEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME,
    LANG: 'en_US.UTF-8', ...extra };
}
export interface CommandResult { code: number; stdout: Buffer; stderr: Buffer }
export async function command(argv: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal;
} = {}): Promise<CommandResult> {
  if (!argv[0] || argv.some(a => a.includes('\0'))) throw new Error('Invalid command argv');
  return new Promise((accept, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env ?? hostEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let bytes = 0; let failure: Error | undefined;
    const out: Buffer[] = []; const err: Buffer[] = [];
    const stop = (reason: Error) => {
      failure ??= reason;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* close/error proves termination */ }
    };
    const timer = setTimeout(() => stop(new Error('Command timed out')), options.timeoutMs ?? 30_000);
    const abort = () => stop(new Error('Command cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]] as const) {
      stream.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > (options.maxBytes ?? 1024 * 1024)) stop(new Error('Command output limit exceeded'));
        else chunks.push(data);
      });
    }
    child.on('error', e => { failure = e; });
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else accept({ code: code ?? 128, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}
export function requireSuccess(result: CommandResult): Buffer {
  if (result.code !== 0) throw new Error(`Command failed (${result.code}): ${clean(result.stderr.toString()).slice(0, 2000)}`);
  return result.stdout;
}
