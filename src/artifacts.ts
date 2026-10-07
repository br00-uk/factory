import { z } from 'zod';
import { lstat, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, fingerprint, hash, inside, privateDirectory, relativePath } from './safety.js';
import type { Config } from './config.js';

export const FileSchema = z.strictObject({ path: z.string().refine(p => { try { relativePath(p); return true; } catch { return false; } }),
  mode: z.enum(['100644', '100755']), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const ManifestSchema = z.array(FileSchema).max(50000);
export type Manifest = z.infer<typeof ManifestSchema>;
export interface Snapshot { hash: string; directory: string; manifest: Manifest }

export async function storeSnapshot(root: string, entries: {path: string; mode: '100644' | '100755'; data: Buffer}[], limits: Config['limits']): Promise<Snapshot> {
  const manifest: Manifest = []; let total = 0;
  for (const entry of entries) {
    relativePath(entry.path); total += entry.data.length;
    if (entry.data.length > limits.maxFileBytes || total > limits.maxArtifactBytes) throw new Error('Source artifact exceeds configured size limit');
    manifest.push({ path: entry.path, mode: entry.mode, size: entry.data.length, sha256: hash(entry.data) });
  }
  manifest.sort((a,b) => a.path.localeCompare(b.path, 'en'));
  validateManifest(manifest, limits);
  const id = fingerprint(manifest); const directory = join(root, id);
  await privateDirectory(directory);
  for (const entry of entries) {
    const file = inside(join(directory, 'source'), entry.path);
    await atomicWrite(file, entry.data);
  }
  await atomicWrite(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { hash: id, directory, manifest };
}
export function validateManifest(value: unknown, limits: Config['limits']): Manifest {
  const manifest = ManifestSchema.parse(value); const seen = new Set<string>(); let size = 0;
  for (const file of manifest) {
    // Case-folding also rejects aliases on the Mac's usual case-insensitive filesystem.
    const normalized = file.path.normalize('NFC').toLowerCase();
    if (seen.has(normalized)) throw new Error(`Duplicate/aliased artifact path: ${file.path}`);
    seen.add(normalized); size += file.size;
    if (file.size > limits.maxFileBytes || size > limits.maxArtifactBytes) throw new Error('Artifact size limit exceeded');
  }
  for (const file of manifest) {
    const parts = file.path.split('/'); parts.pop();
    while (parts.length) { if (seen.has(parts.join('/').normalize('NFC').toLowerCase())) throw new Error('Artifact file/directory collision'); parts.pop(); }
  }
  return manifest;
}
export async function readSnapshot(root: string, id: string, limits: Config['limits']): Promise<Snapshot> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid artifact hash');
  const directory = join(root, id);
  const manifest = validateManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), limits);
  if (fingerprint(manifest) !== id) throw new Error('Artifact manifest integrity failure');
  for (const file of manifest) {
    const path = inside(join(directory, 'source'), file.path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) throw new Error('Artifact type/size integrity failure');
    if (hash(await readFile(path)) !== file.sha256) throw new Error('Artifact content integrity failure');
  }
  return { hash: id, directory, manifest };
}
export function changedPaths(before: Manifest, after: Manifest): string[] {
  const old = new Map(before.map(f => [f.path, fingerprint(f)]));
  const next = new Map(after.map(f => [f.path, fingerprint(f)]));
  return [...new Set([...old.keys(), ...next.keys()])].filter(p => old.get(p) !== next.get(p)).sort();
}
export function enforceScope(changed: string[], allowed: string[]): void {
  for (const path of changed) if (!allowed.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) {
    throw new Error(`Candidate changes an unapproved path: ${path}`);
  }
}
export async function scanSecrets(snapshot: Snapshot): Promise<string[]> {
  const findings: string[] = [];
  const patterns = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/];
  for (const f of snapshot.manifest) {
    const bytes = await readFile(inside(join(snapshot.directory, 'source'), f.path));
    if (patterns.some(p => p.test(bytes.toString('utf8')))) findings.push(f.path);
  }
  return findings;
}
export async function cleanup(root: string, protectedHashes: Set<string>): Promise<number> {
  // Only complete hash directories are eligible; callers hold the supervisor lock.
  const { rm } = await import('node:fs/promises'); let count = 0;
  for (const name of await readdir(root)) if (/^[a-f0-9]{64}$/.test(name) && !protectedHashes.has(name)) {
    await rm(join(root, name), { recursive: true }); count++;
  }
  return count;
}
