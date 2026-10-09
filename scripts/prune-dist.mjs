// Remove compiled outputs whose source no longer exists, so stale tests and
// modules cannot run after a file is deleted or renamed.
import { readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
for(const dir of ['src','tests','scripts','pi-extension']){
  const out=join(root,'dist',dir);
  if(!existsSync(out))continue;
  for(const name of await readdir(out)){
    const base=name.replace(/\.(d\.ts|js|js\.map|d\.ts\.map)$/,'');
    if(base===name)continue;
    if(!existsSync(join(root,dir,`${base}.ts`))&&!existsSync(join(root,dir,`${base}.mjs`)))await rm(join(out,name),{force:true});
  }
}
