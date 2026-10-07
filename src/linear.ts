import { z } from 'zod';
import type { Config } from './config.js';
import { paths, ROOT, projectPath } from './config.js';
import { command, hostEnvironment, requireSuccess } from './safety.js';
import { IssueSchema, type Issue } from './models.js';
import { join } from 'node:path';

export class Linear {
  private pending: Promise<unknown> = Promise.resolve();
  organizationId:string|undefined;
  constructor(private readonly config: Config, private readonly root = ROOT) {}
  private read(args: string[]): Promise<unknown> {
    const operation = this.pending.then(async () => {
      const result = await command([join(paths(this.root).tools,'linear-tui'),...args], {
        env: hostEnvironment({ LINEAR_TUI_STATE_DIR: join(paths(this.root).state,'linear') }),
        cwd: this.config.repository, timeoutMs:30_000,maxBytes:1024*1024 });
      try { return JSON.parse(requireSuccess(result).toString()); }
      catch (e) { throw new Error(`Linear read unavailable: ${(e as Error).message}`); }
    });
    this.pending = operation.catch(() => undefined); return operation;
  }
  identifier(input: string): string {
    let identifier = input;
    if (input.includes('://')) {
      const url = new URL(input);
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.username || url.password || parts[0] !== this.config.linear.organization || parts[1] !== 'issue') throw new Error('Issue URL belongs to another organization or has an unsupported format');
      identifier = parts[2] ?? '';
    }
    identifier = identifier.toUpperCase();
    if (!new RegExp(`^${this.config.linear.team??'[A-Z][A-Z0-9]*'}-[1-9][0-9]*$`).test(identifier)) throw new Error('Issue is outside the configured Linear team');
    return identifier;
  }
  async issue(input: string): Promise<Issue> {
    const identifier = this.identifier(input);
    const data = IssueSchema.parse(await this.read(['issue','show',identifier,'--json']));
    if (this.identifier(data.url) !== identifier || data.identifier !== identifier) throw new Error('Linear returned another issue identity');
    if(this.config.linear.project){
      const project=await this.project();
      if(data.project?.id!==project.id)throw new Error('Issue is outside the configured Linear project');
    }
    return data;
  }
  async project():Promise<{id:string;name:string;url:string}> {
    const configured=this.config.linear.project;
    if(!configured)throw new Error('No Linear project is configured');
    const project=z.object({id:z.string().uuid(),name:z.string(),url:z.string().url()})
      .parse(await this.read(['project','show',configured.name,'--json']));
    if(projectPath(project.url,this.config.linear.organization)!==projectPath(configured.url,this.config.linear.organization))throw new Error('Linear returned another project identity or organization');
    return project;
  }
  async current(): Promise<Issue> {
    const context=await this.view();
    if (!context.running || !context.snapshot) throw new Error('Selected context unavailable/stale; use an explicit issue ID');
    if (context.workspace !== this.config.repository) throw new Error('Context refers to another repository');
    const selected = selectedIssue(context.snapshot, this.config);
    this.organizationId=z.object({organization:z.object({id:z.string().uuid()})}).parse(context.snapshot).organization.id;
    const issue = await this.issue(selected.identifier);
    if (issue.id !== selected.id) throw new Error('Selected issue UUID changed during resolution');
    return issue;
  }
  async view():Promise<{workspace:string;running:boolean|null;snapshot:unknown}> {
    const result=z.object({workspace:z.string(),running:z.boolean().nullable(),snapshot:z.unknown().nullable()})
      .parse(await this.read(['context','--json','--workspace',this.config.repository]));
    if(result.workspace!==this.config.repository)throw new Error('Linear view refers to another repository');
    return result;
  }
  async ready():Promise<void> {
    const view=await this.view();
    if(!view.running)throw new Error('Linear TUI is not running');
    const snapshot=z.object({version:z.literal(1),organization:z.object({id:z.string().uuid(),url_key:z.string()}),closed_at:z.string().optional()}).parse(view.snapshot);
    if(snapshot.closed_at||snapshot.organization.url_key!==this.config.linear.organization)throw new Error('Linear TUI has stale data or another active organization');
    this.organizationId=snapshot.organization.id;
  }
  async confirmOrganization(expected:string):Promise<void> {
    const view=await this.view();
    const snapshot=z.object({version:z.literal(1),organization:z.object({id:z.string().uuid(),url_key:z.string()}),closed_at:z.string().optional()}).parse(view.snapshot);
    if(!view.running||snapshot.closed_at||snapshot.organization.url_key!==this.config.linear.organization||snapshot.organization.id!==expected)
      throw new Error('Recorded Linear organization changed or is unavailable');
  }
}
export function selectedIssue(value: unknown, config: Config): {id:string;identifier:string} {
  const ref = z.object({id:z.string().uuid(),identifier:z.string()});
  const view = z.object({version:z.literal(1),organization:z.object({id:z.string().uuid(),url_key:z.string()}),
    screen:z.string(),issue:ref.optional(),rows:z.array(z.object({kind:z.string(),id:z.string().uuid(),identifier:z.string().optional()})),
    selected_row:z.number().int().nonnegative().optional(),closed_at:z.string().optional()}).parse(value);
  if (view.closed_at || view.organization.url_key !== config.linear.organization) throw new Error('Stale view or another Linear organization');
  const selected = view.screen === 'issue_detail' ? view.issue : view.rows[view.selected_row ?? -1];
  if (!selected || ('kind' in selected && selected.kind !== 'issue') || !selected.identifier) throw new Error('No issue is selected (partial context)');
  return {id:selected.id,identifier:selected.identifier};
}
