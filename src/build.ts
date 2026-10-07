import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { fingerprint, hash } from './safety.js';

export async function buildHash():Promise<string> {
  const relative=import.meta.dirname.endsWith('/dist/src')?'dist/src':'src';
  const suffix=relative==='dist/src'?'.js':'.ts';
  const files=(await readdir(join(ROOT,relative))).filter(name=>name.endsWith(suffix)).map(name=>`${relative}/${name}`).sort();
  files.push('package-lock.json','scripts/lock.py','scripts/prepare-toolchain.py','pi-extension/index.ts');
  return fingerprint(await Promise.all(files.map(async file=>({file,sha256:hash(await readFile(join(ROOT,file)))}))));
}
