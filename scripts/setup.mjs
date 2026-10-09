import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The supported host is Apple Silicon macOS.');
}
if (!/^v26\.5\./.test(process.version)) throw new Error('Use Node 26.5.x (.node-version pins 26.5.0).');
for (const [exe,args] of [['python3',['--version']],['/usr/bin/git',['--version']],['npm',['ci','--ignore-scripts']],
  ['npm',['run','build']],['node',['dist/src/cli.js','setup-integrations']]]) {
  const result = spawnSync(exe,args,{stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
