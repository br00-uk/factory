import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { command, hostEnvironment, requireSuccess, inside, privateDirectory } from './safety.js';
import { storeSnapshot, type Snapshot } from './artifacts.js';

const gitEnv = () => hostEnvironment({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' });
export async function git(repository: string, args: string[], maxBytes = 1024 * 1024): Promise<Buffer> {
  return requireSuccess(await command(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=', '-c', 'protocol.file.allow=always', '-C', repository, ...args],
  { env: gitEnv(), maxBytes, timeoutMs: 60_000 }));
}
export async function baseCommit(config: Config): Promise<string> {
  const value = (await git(config.repository, ['rev-parse', '--verify', `${config.baseRef}^{commit}`])).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Only SHA-1 Git repositories are supported in V1');
  return value;
}
export async function snapshotRepository(config: Config, base: string, artifacts: string): Promise<Snapshot> {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid base commit');
  const bytes = await git(config.repository, ['ls-tree', '-rz', '--full-tree', base], config.limits.maxArtifactBytes);
  let listing:string;
  try{listing=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch{throw new Error('Git source paths must have valid UTF-8; refusing a lossy snapshot');}
  const entries: {path: string; mode: '100644' | '100755'; data: Buffer}[] = [];
  let total = 0;
  for (const line of listing.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('Symlinks and submodules are unsupported; register a repository without them');
    const data = await git(config.repository, ['cat-file', 'blob', match[2]!], config.limits.maxFileBytes);
    total += data.length; if (total > config.limits.maxArtifactBytes) throw new Error('Repository exceeds source artifact bound');
    entries.push({ path: match[3]!, mode: match[1] as '100644' | '100755', data });
  }
  return storeSnapshot(artifacts, entries, config.limits);
}
export async function commitCandidate(config: Config, state: string, base: string, snapshot: Snapshot): Promise<{ commit: string; repository: string; diff: string }> {
  const repository = join(state, 'candidates.git');
  await privateDirectory(repository);
  await git(repository, ['init', '--bare', '--quiet']);
  await git(repository, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', config.repository, base]);
  // Serialize packaging; the supervisor owns this index and bare repository.
  await git(repository, ['read-tree', '--empty']);
  for (const file of snapshot.manifest) {
    const blob = (await git(repository, ['hash-object', '-w', '--no-filters', inside(join(snapshot.directory, 'source'), file.path)])).toString().trim();
    await git(repository, ['update-index', '--add', '--cacheinfo', file.mode, blob, file.path]);
  }
  const tree = (await git(repository, ['write-tree'])).toString().trim();
  const result = await command(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-C', repository,
    'commit-tree', tree, '-p', base, '-m', `Factory candidate ${snapshot.hash}`], { env: { ...gitEnv(),
      GIT_AUTHOR_NAME: 'Local Factory', GIT_AUTHOR_EMAIL: 'factory@localhost',
      GIT_COMMITTER_NAME: 'Local Factory', GIT_COMMITTER_EMAIL: 'factory@localhost' } });
  const commit = requireSuccess(result).toString().trim();
  await git(repository, ['update-ref', `refs/heads/candidate-${snapshot.hash}`, commit]);
  const diff = (await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--binary', base, commit], config.limits.maxArtifactBytes)).toString();
  return { commit, repository, diff };
}
