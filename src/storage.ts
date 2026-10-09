import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { executing, transitions, type HumanRequest, type Run, type Status } from './models.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    const file = join(directory, 'factory.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stages(id INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), stage TEXT NOT NULL, input TEXT NOT NULL, started TEXT NOT NULL, finished TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS approvals(run TEXT NOT NULL REFERENCES runs(id), gate TEXT NOT NULL, hash TEXT NOT NULL, identity TEXT NOT NULL, time TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run,gate,hash));
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vms(name TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), owner TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if ((this.db.prepare('SELECT version FROM schema_version').get() as {version:number}).version !== 1) throw new Error('Unsupported database schema; do not resume across factory upgrades');
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  all(): Run[] { return (this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC').all() as {data:string}[]).map(r => JSON.parse(r.data) as Run); }
  get(id: string): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id) as {data:string} | undefined;
    if (!row) throw new Error('Unknown run'); return JSON.parse(row.data) as Run;
  }
  save(run: Run): void {
    run.updated = new Date().toISOString();
    this.db.prepare('INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data')
      .run(run.id, run.issue.id, run.status, JSON.stringify(run));
  }
  create(run: Run): void {
    if (this.all().some(r => r.issue.id === run.issue.id && !['ready_for_manual_merge','cancelled'].includes(r.status))) throw new Error('This issue already has an unfinished run');
    this.ensureSlot(); this.save(run);
  }
  ensureSlot(except?: string): void {
    const guests = new Set(this.unresolvedWorkspaces().map(w=>w.run));
    if (this.all().some(r => r.id !== except && executing.has(r.status) && (r.status!=='awaiting_input'||guests.has(r.id)))) throw new Error('Another run holds the execution slot');
  }
  transition(run: Run, status: Status): void {
    if (!transitions[run.status].includes(status)) throw new Error(`Invalid transition ${run.status} → ${status}`);
    if (executing.has(status)) this.ensureSlot(run.id);
    run.status = status; this.save(run);
  }
  intent(run: Run, input: string): number {
    return Number(this.db.prepare('INSERT INTO stages(run,stage,input,started) VALUES(?,?,?,?)')
      .run(run.id, run.status, input, new Date().toISOString()).lastInsertRowid);
  }
  finish(attempt: number, result: unknown): void {
    this.db.prepare('UPDATE stages SET finished=?,result=? WHERE id=? AND finished IS NULL')
      .run(new Date().toISOString(), JSON.stringify(result), attempt);
  }
  approve(run: Run, gate: 'plan' | 'candidate', hash: string, identity: string): void {
    const current=this.get(run.id);
    if (current.status !== (gate === 'plan' ? 'awaiting_plan_approval' : 'awaiting_merge_approval')
      || hash !== (gate === 'plan' ? current.planHash : current.candidate?.evidenceHash)) throw new Error('Approval does not match the current gate and evidence');
    if(gate==='candidate'&&!this.approved(current))throw new Error('Candidate approval requires an unrevoked plan approval');
    this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,0) ON CONFLICT(run,gate,hash) DO UPDATE SET time=excluded.time,identity=excluded.identity,revoked=0')
      .run(run.id, gate, hash, identity, new Date().toISOString());
  }
  approved(run: Run): boolean {
    return !!this.db.prepare('SELECT 1 FROM approvals WHERE run=? AND gate=\'plan\' AND hash=? AND revoked=0').get(run.id, run.planHash ?? '');
  }
  revoke(run: Run): void { this.db.prepare('UPDATE approvals SET revoked=1 WHERE run=?').run(run.id); }
  request(value: HumanRequest): void {
    this.db.prepare('INSERT INTO requests VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, value.run, JSON.stringify(value));
  }
  requests(run: string): HumanRequest[] {
    return (this.db.prepare('SELECT data FROM requests WHERE run=?').all(run) as {data:string}[]).map(r => JSON.parse(r.data) as HumanRequest);
  }
  obsoleteRequests(run:string,reason:string):void {
    for(const request of this.requests(run).filter(q=>q.pending)){request.pending=false;request.obsolete=reason;this.request(request);}
  }
  answer(run: Run, id: string, answer: string): HumanRequest {
    return this.transaction(() => this.recordAnswer(run,id,answer));
  }
  recordAnswer(run:Run,id:string,answer:string):HumanRequest {
      if(!this.db.isTransaction)throw new Error('Human answer must be recorded inside a transaction');
      const request = this.requests(run.id).find(q => q.id === id);
      const context = run.candidate?.hash ?? run.planHash ?? run.source;
      if (!request?.pending || request.context !== context || !['awaiting_input','paused','interrupted','failed'].includes(run.status)) throw new Error('Obsolete or inactive human request');
      request.pending = false; request.answer = answer; this.request(request);
      run.messages.push({kind:'answer',text:answer,time:new Date().toISOString()}); this.save(run); return request;
  }
  setting(key: string): string | undefined { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string} | undefined)?.value; }
  setSetting(key: string, value: string): void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  artifactReferences():Set<string> {
    const hashes=new Set<string>();
    const collect=(value:unknown):void=>{
      if(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))hashes.add(value);
      else if(Array.isArray(value))value.forEach(collect);
      else if(value&&typeof value==='object')Object.values(value).forEach(collect);
    };
    this.all().forEach(collect);
    for(const row of this.db.prepare('SELECT result FROM stages WHERE result IS NOT NULL').all() as {result:string}[])collect(JSON.parse(row.result));
    return hashes;
  }
  // Sandboxed stage workspaces, recorded before creation. The table keeps its
  // historical name so an existing installation database stays readable.
  recordWorkspace(run: string, name: string, owner: string): void { this.db.prepare('INSERT INTO vms(name,run,owner) VALUES(?,?,?)').run(name,run,owner); }
  stoppedWorkspace(name: string): void { this.db.prepare('UPDATE vms SET stopped=1 WHERE name=?').run(name); }
  unresolvedWorkspaces(): {name:string;run:string;owner:string}[] { return this.db.prepare('SELECT name,run,owner FROM vms WHERE stopped=0').all() as {name:string;run:string;owner:string}[]; }
  interrupt(): void {
    for (const run of this.all()) if (executing.has(run.status) && run.status !== 'awaiting_input') {
      run.previous = run.status; run.blocker = 'Supervisor interrupted; explicitly resume from the last saved candidate'; this.transition(run,'interrupted');
    }
  }
}
