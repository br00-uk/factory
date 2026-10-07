import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { hostEnvironment, privateDirectory } from './safety.js';
import { ROOT } from './config.js';

export async function lock(directory: string): Promise<() => Promise<void>> {
  await privateDirectory(directory);
  const child = spawn('python3', [join(ROOT, 'scripts/lock.py'), join(directory, 'supervisor.lock')],
    { env: hostEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Supervisor lock timed out')); }, 5000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Supervisor lock unavailable (${code})`)); });
    child.stdout.once('data', (data: Buffer) => {
      clearTimeout(timer);
      if (data.toString().trim() === 'LOCKED') accept();
      else reject(new Error('Another supervisor holds the installation lock'));
    });
  });
  let released = false;
  child.once('exit',()=>{
    // Losing the lifetime lock means authority is lost. Stop this owner immediately;
    // the engine reaps its VM and the next supervisor must confirm recorded deletion.
    if(!released)process.kill(process.pid,'SIGKILL');
  });
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>(accept => { child.once('exit', () => accept()); child.stdin.end(); });
  };
}
