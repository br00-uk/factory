import { readFile, realpath } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { fingerprint } from './safety.js';
import { relativePath } from './safety.js';

export const PLATFORMS = ['linux-arm64','linux-x64','darwin-arm64','darwin-x64','windows-x64'] as const;
export type Platform = typeof PLATFORMS[number];
export function hostPlatform(): Platform | undefined {
  const value = `${process.platform}-${process.arch}` as Platform;
  return PLATFORMS.includes(value) ? value : undefined;
}
export const CheckSchema = z.strictObject({
  name: z.string().min(1).max(80), argv: z.array(z.string().max(4096)).min(1).max(64),
  timeoutSeconds: z.number().int().min(1).max(3600),
  required: z.boolean().default(true),
  platform: z.enum(PLATFORMS).optional(),
  acceptBaselineFailure: z.strictObject({reason:z.string().trim().min(1).max(2000)}).optional(),
});
const HostName=z.string().regex(/^(?=.{1,253}$)(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/);
const BootstrapSchema=z.strictObject({argv:CheckSchema.shape.argv,timeoutSeconds:CheckSchema.shape.timeoutSeconds,
  allowHosts:z.array(HostName).max(20),
});
const GeneratedPath=z.string().refine(p=>{try{relativePath(p);return true;}catch{return false;}},'Use a confined relative dependency directory');
const HostPath=z.string().min(1).max(1024).refine(p=>isAbsolute(p)||p.startsWith('~/'),'Use an absolute or ~/ path');
export const ConfigSchema = z.strictObject({
  repository: z.string().refine(isAbsolute, 'Use an absolute repository path'),
  baseRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/),
  linear: z.strictObject({ organization: z.string().regex(/^[a-z0-9-]+$/),
    team: z.string().regex(/^[A-Z][A-Z0-9]*$/).optional(),
    project: z.strictObject({name:z.string().min(1).max(200),url:z.string().url()}).optional() })
    .refine(l=>Boolean(l.team||l.project),'Configure a Linear team or project')
    .refine(l=>!l.project||projectPath(l.project.url,l.organization)!==undefined,'Project URL must identify the configured Linear organization'),
  model: z.strictObject({ provider: z.string().min(1), id: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    authFile: z.string().refine(isAbsolute, 'Use an absolute Pi auth.json path').optional(),
    maxOutputTokens: z.number().int().min(256).max(65536) })
    .refine(m => Boolean(m.apiKeyEnv) !== Boolean(m.authFile), 'Choose exactly one credential reference: apiKeyEnv or authFile'),
  budgetUsd: z.number().positive().max(1000).nullable(),
  telegram: z.strictObject({ tokenEnv:z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    userId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    chatId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional(),
  // The execution environment is this host, confined by the OS sandbox: tools come
  // from the host PATH, dependencies are prepared once per workspace under an
  // explicit registry allowlist, and everything else runs with egress denied.
  environment: z.strictObject({
    dependencies:BootstrapSchema.extend({paths:z.array(GeneratedPath).max(20).default([])}).optional(),
    env:z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/).refine(k=>!/(?:TOKEN|PASSWORD|SECRET|KEY|AUTH|COOKIE)/.test(k),'Sandbox credentials are unsupported'),z.string().max(4096)).default({}),
    sandbox:z.strictObject({denyRead:z.array(HostPath).max(50).default([]),allowRead:z.array(HostPath).max(50).default([])}).default({denyRead:[],allowRead:[]}),
    checks: z.array(CheckSchema).min(1).max(20)
      .refine(checks=>new Set(checks.map(c=>c.name)).size===checks.length,'Check names must be unique')
      .refine(checks=>checks.some(c=>c.required),'Register at least one required verification method') }),
  limits: z.strictObject({ stageSeconds: z.number().int().min(30).max(14400),
    activeSeconds: z.number().int().min(30).max(86400).default(7200),
    commandSeconds: z.number().int().min(1).max(3600), maxOutputBytes: z.number().int().min(1024).max(4*1024*1024),
    maxFileBytes: z.number().int().min(1024).max(16*1024*1024), maxArtifactBytes: z.number().int().min(1024).max(512*1024*1024),
    maxTurns: z.number().int().min(1).max(100) }),
});
export type Config = z.infer<typeof ConfigSchema>;
export function projectPath(input:string,organization:string):string|undefined {
  try{
    const u=new URL(input);const parts=u.pathname.split('/').filter(Boolean);
    if(u.protocol==='https:'&&u.hostname==='linear.app'&&!u.username&&!u.password&&!u.search&&!u.hash
      &&parts[0]===organization&&parts[1]==='project'&&parts[2]&&parts.length<=4
      &&(!parts[3]||parts[3]==='overview'))return parts.slice(0,3).join('/');
  }catch{/* invalid URL is unavailable */}
  return undefined;
}
export const credentialEnvs = (config:Config):string[] => [
  ...(config.model.apiKeyEnv ? [config.model.apiKeyEnv] : []),
  ...(config.telegram ? [config.telegram.tokenEnv] : []),
];
export const ROOT = import.meta.dirname.endsWith('/dist/src')
  ? resolve(import.meta.dirname, '../..') : resolve(import.meta.dirname, '..');
export function paths(root = ROOT) {
  const state = resolve(root, '.factory');
  return { root, state, config: resolve(root, 'factory.local.json'), socket: resolve(state, 'control.sock'),
    tools: resolve(root, '.cache/tools'), artifacts: resolve(state, 'artifacts'), sessions: resolve(state, 'sessions'),
    work: resolve(state, 'work'), cache: resolve(state, 'cache'), log: resolve(state, 'supervisor.log') };
}
export async function loadConfig(root = ROOT): Promise<Config> {
  let input: unknown;
  try { input = JSON.parse(await readFile(paths(root).config, 'utf8')); }
  catch { throw new Error('Configure factory.local.json first: run factory init inside the target repository, or copy factory.example.json.'); }
  const result = ConfigSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid factory.local.json: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  try{result.data.repository=await realpath(result.data.repository);}
  catch{throw new Error('Set factory.local.json repository to an existing absolute checkout path.');}
  if(result.data.model.authFile){
    let credential:string;
    try{credential=await realpath(result.data.model.authFile);}
    catch{throw new Error('Pi authFile is unavailable; configure the existing private host OAuth file after Pi /login.');}
    if(credential===result.data.repository||credential.startsWith(`${result.data.repository}/`))throw new Error('Keep Pi credentials outside the target repository');
  }
  return result.data;
}
export const configHash = (config: Config): string => fingerprint(config);
