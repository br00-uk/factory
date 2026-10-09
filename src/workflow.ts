import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { PlanSchema, ReviewSchema, type CheckResult, type Run, type Status } from './models.js';
import { configHash, paths, type Config } from './config.js';
import { atomicWrite, fingerprint, hash, relativePath, clean } from './safety.js';
import { changedPaths, enforceScope, readSnapshot, scanSecrets } from './artifacts.js';
import { baseCommit, commitCandidate, snapshotRepository } from './git.js';
import { Workspace, stopRecordedWorkspaces, hostRunner } from './host.js';
import { runAgent, trustedLoader } from './pi.js';
import type { Store } from './storage.js';
import type { Linear } from './linear.js';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { buildHash } from './build.js';
import { baselineAccepted, cachedBaseline, matchingFailure, saveBaseline, verificationAccepted, verifyCheckLogs, unavailableCheck } from './checks.js';

export function planFingerprint(run: Run): string {
  return fingerprint({factory:'0.1.0',prompt:trustedLoader('planner').getSystemPrompt(),issue:run.issueHash,
    base:run.base,source:run.source,organization:run.organizationId,config:run.configHash,build:run.buildHash,plan:run.plan,
    baseline:run.baseline,planSource:run.planSource ?? run.source});
}
class StageLimit extends Error {}
export class Workflow {
  stopping=false;
  active: {run:Run;controller:AbortController;done:Promise<void>;guest?:Workspace | undefined;session?:AgentSession | undefined} | undefined;
  private answerPending: {id:string;resolve:(answer:string)=>void;reject:(error:Error)=>void} | undefined;
  private waitingMs=0;
  private waitingSince:number|undefined;
  constructor(readonly config: Config, readonly store: Store, readonly linear: Linear,
    readonly owner: string, readonly root: string, private readonly agent = runAgent,
    private readonly currentConfig?:()=>Promise<Config>) {}
  private async configurationCurrent():Promise<void>{
    if(this.currentConfig&&configHash(await this.currentConfig())!==configHash(this.config))
      throw new Error('Supervisor configuration changed; run make down then make up before revising or continuing');
  }
  getRun(id: string): Run { return this.active?.run.id === id ? this.active.run : this.store.get(id); }
  private version(run:Run):string {
    const {updated:_updated,progress:_progress,activeSeconds:_active,...material}=run;
    return fingerprint(material);
  }
  private unchanged(run:Run,version:string):void {
    if(this.version(this.store.get(run.id))!==version)throw new Error('Run changed while checking context; inspect its current state and retry');
  }
  async context(run: Run): Promise<void> {
    await this.configurationCurrent();
    if(run.buildHash!==await buildHash())throw new Error('Factory code changed; explicitly revise/revalidate this run before continuation');
    if (run.configHash !== configHash(this.config)) throw new Error('Configuration changed; revise and reapprove the plan');
    if (await baseCommit(this.config) !== run.base) throw new Error('Base commit changed; return to planning');
    const issue = await this.linear.issue(run.issue.identifier);
    if (issue.id !== run.issue.id || fingerprint(issue) !== run.issueHash) throw new Error('Issue identity or contents changed; return to planning');
    if(run.organizationId){
      if(issue.organization_id){if(issue.organization_id!==run.organizationId)throw new Error('Recorded Linear organization changed');}
      else await this.linear.confirmOrganization(run.organizationId);
    }
    if (run.plan && planFingerprint(run) !== run.planHash) throw new Error('Plan approval inputs changed');
    if(run.plan){
      if(!baselineAccepted(run))throw new Error('Approved baseline evidence is missing or unacceptable');
      await verifyCheckLogs(this.root,run,run.baseline);
    }
    await readSnapshot(paths(this.root).artifacts,run.source,run.config.limits);
  }
  async plan(input: string): Promise<Run> {
    if(this.stopping)throw new Error('Supervisor stopping');
    if (this.active) throw new Error('A stage is still stopping or executing');
    await this.configurationCurrent();
    this.store.ensureSlot(); await stopRecordedWorkspaces(this.store,this.owner);
    const issue = input === 'current' ? await this.linear.current() : await this.linear.issue(input);
    const base = await baseCommit(this.config);
    const snapshot = await snapshotRepository(this.config,base,paths(this.root).artifacts);
    const now = new Date().toISOString();
    const run: Run = {id:`F-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,status:'planning',created:now,updated:now,
      issue,issueHash:fingerprint(issue),config:this.config,configHash:configHash(this.config),base,source:snapshot.hash,
      buildHash:await buildHash(),baseline:[],repairCount:0,spentUsd:0,turns:0,messages:[]};
    const organizationId=issue.organization_id??this.linear.organizationId;
    if(issue.organization_id&&this.linear.organizationId&&issue.organization_id!==this.linear.organizationId)throw new Error('Issue and selected Linear organization identities differ');
    if(organizationId)run.organizationId=organizationId;
    if(this.stopping)throw new Error('Supervisor stopping');
    this.store.create(run); this.launch(run); return run;
  }
  launch(run: Run): void {
    if(this.stopping)throw new Error('Supervisor stopping');
    if (this.active) throw new Error('A stage is still executing/stopping');
    const controller = new AbortController();
    const active = {run,controller,done:Promise.resolve()} as NonNullable<Workflow['active']>;
    this.active = active;
    active.done = this.perform(run,controller.signal).catch(e => {
      if (!controller.signal.aborted) {
        if(run.status!=='awaiting_input')run.previous=run.status;
        run.blocker = clean((e as Error).message); this.store.transition(run,e instanceof StageLimit?'paused':'failed');
        console.error(clean(`${run.id}: ${run.blocker}`));
      }
    }).finally(async () => {
      try { await active.guest?.close(); }
      catch (e) { run.blocker = `Workspace termination unconfirmed: ${(e as Error).message}`; this.store.save(run); }
      this.active = undefined;
    });
  }
  private check(signal: AbortSignal): void { if (signal.aborted) throw new Error('Stage stopped'); }
  private progress(run:Run,text:string):void {
    run.progress=text;this.store.save(run);console.log(clean(`${run.id}: ${run.status} — ${text}`));
  }
  private async guest(run: Run, signal: AbortSignal): Promise<Workspace> {
    this.check(signal);
    await stopRecordedWorkspaces(this.store,this.owner);
    this.progress(run,'Creating a sandboxed workspace');
    const guest = await Workspace.create(run.config,this.owner,run.id,this.store,this.root);
    this.active!.guest = guest;
    this.check(signal);
    const source = run.status==='planning' ? run.source : (run.candidate?.hash ?? run.source);
    this.progress(run,'Importing source into the sandbox (egress denied)');
    await guest.import(await readSnapshot(paths(this.root).artifacts,source,run.config.limits));
    if(run.config.environment.dependencies){
      this.progress(run,'Preparing registered dependencies under their registry allowlist');
      await guest.prepareDependencies();
      this.check(signal);
      const prepared=await guest.export(paths(this.root).artifacts);
      if(prepared.hash!==source)throw new Error('Dependency preparation changed source outside registered dependency directories');
      // export freezes source; make it writable again before implementation or
      // checks that write temporary outputs. Verification freezes it again.
      await guest.unfreeze();
    }
    if(guest.preparation.length){
      const log=join(paths(this.root).state,'runs',run.id,`${run.status}-preparation-${crypto.randomUUID()}.log`);
      await atomicWrite(log,clean(JSON.stringify(guest.preparation)));
      (run.preparationLogs??=[]).push(log);this.store.save(run);
    }
    return guest;
  }
  private async checks(run: Run, guest: Workspace, source: string, signal: AbortSignal): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    if(run.status==='planning')run.baseline=results;
    else if(run.candidate)run.candidate.checks=results;
    for (const check of run.config.environment.checks) {
      const started = new Date().toISOString();
      this.progress(run,`Running registered check: ${check.name}`);
      let code: number | null = null; let output = ''; let outcome: CheckResult['outcome'] = 'unavailable';
      if(signal.aborted||guest.stopped){outcome='skipped';output=signal.aborted?'Not run: stage stopped':'Not run: preceding workspace execution unavailable';}
      else if(unavailableCheck(check)){output=unavailableCheck(check)!;}
      else try {
        const result = await guest.execute(check.argv,{timeout:check.timeoutSeconds,signal});
        output = clean(result.stdout+result.stderr);
        if(result.code===126||result.code===127){outcome='unavailable';}
        else{code=result.code;outcome=code===0?'passed':'failed';}
      } catch (e) { output = clean((e as Error).message); }
      const log = join(paths(this.root).state,'runs',run.id,`${run.status}-${results.length}-${crypto.randomUUID()}.log`);
      await atomicWrite(log,output);
      results.push({name:check.name,argv:check.argv,runner:hostRunner(),source,started,
        ended:new Date().toISOString(),code,outcome,log,logHash:hash(output),required:check.required,
        cwd:guest.src,environmentHash:fingerprint(run.config.environment),
        ...(run.status==='verifying'&&outcome==='failed'?{comparison:matchingFailure(run.baseline[results.length],{code,outcome,logHash:hash(output)})?'preexisting' as const:'introduced' as const}:{})});
      this.store.save(run);
    }
    this.check(signal);
    return results;
  }
  private async ask(run: Run, question: string, signal:AbortSignal): Promise<string> {
    this.check(signal);
    if (this.answerPending) throw new Error('One human question may be pending');
    const stage = run.status; run.previous = stage;
    const request = {id:`Q-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,run:run.id,stage,
      context:run.candidate?.hash ?? run.planHash ?? run.source,question:clean(question),pending:true,created:new Date().toISOString()};
    this.store.transaction(()=>{this.store.request(request);this.store.transition(run,'awaiting_input');});
    console.log(`${run.id} ${request.id}: ${request.question}`);
    const started=Date.now();this.waitingSince=started;
    const abort=()=>{this.answerPending?.reject(new Error('Stage stopped while awaiting input'));this.answerPending=undefined;};
    signal.addEventListener('abort',abort,{once:true});
    try{return await new Promise<string>((resolve,reject)=>{this.answerPending={id:request.id,resolve,reject};if(signal.aborted)abort();});}
    finally{signal.removeEventListener('abort',abort);this.waitingMs+=Date.now()-started;this.waitingSince=undefined;}
  }
  private async agentTurn(run: Run, guest: Workspace, role: 'planner'|'implementer'|'reviewer', signal: AbortSignal, extra: unknown): Promise<string> {
    this.progress(run,`Running ${role} session`);
    return this.agent(role,guest,run,this.store,paths(this.root).sessions,JSON.stringify({issue:run.issue,
      plan:run.plan,registeredChecks:run.config.environment.checks,baseline:run.baseline,
      candidate:run.candidate,messages:run.messages,extra}),signal,q=>this.ask(run,q,signal),session=>{this.active!.session=session;});
  }
  private async perform(run: Run, parent: AbortSignal): Promise<void> {
    while (['planning','implementing','repairing','verifying','reviewing'].includes(run.status)) {
      this.check(parent);
      await this.configurationCurrent();
      if(run.buildHash!==await buildHash())throw new Error('Factory code changed during the run; explicit revalidation required');
      if (run.status !== 'planning' && (!this.store.approved(run) || !run.plan)) throw new Error('Implementation requires the current approved plan');
      if((run.activeSeconds??0)>=run.config.limits.activeSeconds)throw new StageLimit('Run active time limit reached; increase the configured limit and revise/reapprove before continuing');
      const budget=new AbortController();
      const signal = AbortSignal.any([parent,budget.signal]);
      const stage = run.status; const attempt = this.store.intent(run,fingerprint({source:run.candidate?.hash??run.source,plan:run.planHash??null,config:run.configHash}));
      const started=Date.now();this.waitingMs=0;
      const activeMs=()=>Date.now()-started-this.waitingMs-(this.waitingSince===undefined?0:Date.now()-this.waitingSince);
      const timer=setInterval(()=>{
        const elapsed=activeMs()/1000;
        if(elapsed>=run.config.limits.stageSeconds||(run.activeSeconds??0)+elapsed>=run.config.limits.activeSeconds)budget.abort();
      },100);
      let guest: Workspace | undefined;
      try {
        guest = await this.guest(run,signal);
        if (stage === 'planning') {
          const cached=await cachedBaseline(this.store,this.root,run);
          if(cached)this.progress(run,'Reusing matching baseline with verified logs');
          run.baseline = cached??await this.checks(run,guest,run.source,signal);
          const checkedSource=await guest.export(paths(this.root).artifacts);
          this.check(signal);
          if(checkedSource.hash!==run.source)throw new Error('Baseline checks changed source; check commands must clean their generated files');
          saveBaseline(this.store,run);
          if (!baselineAccepted(run)) {
            this.store.finish(attempt,{baseline:run.baseline});this.store.save(run);
            throw new Error('Required baseline failed/unavailable; resolve unavailable evidence or explicitly configure acceptance of a matching preexisting failure before replanning.');
          }
          run.planSource = run.candidate?.hash ?? run.source;
          run.plan = PlanSchema.parse(JSON.parse(await this.agentTurn(run,guest,'planner',signal,
            run.candidate?{savedCandidateDiff:await readFile(run.candidate.diffPath,'utf8')}:null)));
          run.plan.paths.forEach(relativePath);
          run.planHash = planFingerprint(run);
          this.check(signal); await guest.close(); this.active!.guest = undefined;
          this.check(signal);
          this.store.transaction(()=>{this.store.finish(attempt,{plan:run.plan,hash:run.planHash,baseline:run.baseline});this.store.transition(run,'awaiting_plan_approval');});
        } else if (stage === 'implementing' || stage === 'repairing') {
          await this.agentTurn(run,guest,'implementer',signal,stage==='repairing'?'Resolve the recorded check/review findings and human comments':null);
          this.check(signal);
          const snapshot = await guest.export(paths(this.root).artifacts);
          this.check(signal);
          const base = await readSnapshot(paths(this.root).artifacts,run.source,run.config.limits);
          this.check(signal);
          enforceScope(changedPaths(base.manifest,snapshot.manifest),run.plan!.paths);
          const secrets = await scanSecrets(snapshot);
          if (secrets.length) throw new Error(`Candidate secret scan failed in: ${secrets.join(', ')}`);
          const packaged = await commitCandidate(run.config,paths(this.root).state,run.base,snapshot);
          this.check(signal);
          const diffPath = join(paths(this.root).state,'runs',run.id,`${snapshot.hash}.diff`);
          await atomicWrite(diffPath,packaged.diff);
          this.check(signal);
          // Candidate changes discard every previous verification/review result.
          run.candidate = {hash:snapshot.hash,commit:packaged.commit,repository:packaged.repository,diffPath,diffHash:hash(packaged.diff),checks:[]};
          this.check(signal); await guest.close(); this.active!.guest = undefined;
          this.check(signal);
          this.store.transaction(()=>{this.store.finish(attempt,run.candidate);this.store.transition(run,'verifying');});
        } else if (stage === 'verifying') {
          if (!run.candidate) throw new Error('No saved candidate to verify');
          run.candidate.checks = await this.checks(run,guest,run.candidate.hash,signal);
          if (run.candidate.checks.some(c=>c.required&&(c.outcome==='unavailable'||c.outcome==='skipped')) || run.candidate.checks.length!==run.config.environment.checks.length) {
            this.store.finish(attempt,{checks:run.candidate.checks});this.store.save(run);throw new Error('Required verification unavailable');
          }
          const after = await guest.export(paths(this.root).artifacts);
          this.check(signal);
          if (after.hash !== run.candidate.hash) throw new Error('Verification changed the frozen source; check commands must clean their generated files');
          this.store.finish(attempt,{checks:run.candidate.checks});
          if (!verificationAccepted(run)) {
            await guest.close(); this.active!.guest=undefined; this.check(signal);this.repair(run);
          } else {
            // Keep the fresh verification workspace for reviewer checks, with frozen source.
            this.store.transition(run,'reviewing');
            await this.review(run,guest,signal);
            this.check(signal); await guest.close(); this.active!.guest=undefined;
            this.check(signal);
            if(run.status==='reviewing')this.store.transition(run,'awaiting_merge_approval');
          }
        } else if (stage === 'reviewing') {
          await guest.freeze();await this.review(run,guest,signal);await guest.close();this.active!.guest=undefined;
          this.check(signal);
          if(run.status==='reviewing')this.store.transition(run,'awaiting_merge_approval');
        }
      } catch (e) {
        this.store.finish(attempt,{error:clean((e as Error).message)});
        if(signal.aborted&&!parent.aborted)throw new StageLimit('Active time limit reached; inspect saved evidence before explicit resume');
        throw e;
      } finally {
        clearInterval(timer);
        try{await guest?.close();}
        finally{run.activeSeconds=(run.activeSeconds??0)+activeMs()/1000;this.store.save(run);}
      }
    }
  }
  private repair(run: Run): void {
    if (run.repairCount >= 2) throw new Error('Two automatic repair rounds exhausted; operator decision required');
    run.repairCount++; this.store.transition(run,'repairing');
  }
  private async review(run: Run, guest: Workspace, signal: AbortSignal): Promise<void> {
    if(!verificationAccepted(run))throw new Error('Required verification evidence is missing');
    await verifyCheckLogs(this.root,run,run.baseline);
    await verifyCheckLogs(this.root,run,run.candidate!.checks);
    this.check(signal);
    const attempt = this.store.intent(run,fingerprint(run.candidate));
    const review = ReviewSchema.parse(JSON.parse(await this.agentTurn(run,guest,'reviewer',signal,
      {diff:await readFile(run.candidate!.diffPath,'utf8')})));
    this.check(signal);
    const actual = await guest.export(paths(this.root).artifacts);
    this.check(signal);
    if (actual.hash!==run.candidate!.hash) throw new Error('Reviewer changed frozen candidate');
    const criteria = new Set(run.plan!.acceptance);
    if (review.acceptance.length!==criteria.size || review.acceptance.some(a=>!criteria.delete(a.criterion)) || criteria.size) throw new Error('Reviewer omitted/duplicated an approved acceptance criterion');
    run.candidate!.review = review;
    this.store.finish(attempt,{review});
    if (review.findings.some(f=>f.severity==='blocking') || review.acceptance.some(a=>!a.passed)) this.repair(run);
    else {
      await verifyCheckLogs(this.root,run,run.candidate!.checks);
      this.check(signal);
      const logs = await Promise.all(run.candidate!.checks.map(async c=>hash(await readFile(c.log))));
      run.candidate!.evidenceHash = fingerprint({candidate:run.candidate!.hash,commit:run.candidate!.commit,
        diff:run.candidate!.diffHash,checks:run.candidate!.checks,logs,review});
      this.store.save(run);
    }
  }
  async approve(run: Run, gate: 'plan'|'candidate', id: string): Promise<void> {
    const version=this.version(run);
    await this.context(run);
    if (this.active) throw new Error('Stage cleanup has not finished');
    await stopRecordedWorkspaces(this.store,this.owner);
    this.unchanged(run,version);
    if (gate==='candidate') {
      if(!this.store.approved(run))throw new Error('Plan approval revoked; revise before candidate approval');
      if (!run.candidate?.evidenceHash || !verificationAccepted(run) || !run.candidate.review) throw new Error('Required evidence is missing');
      await verifyCheckLogs(this.root,run,run.candidate.checks);
      await readSnapshot(paths(this.root).artifacts,run.candidate.hash,run.config.limits);
      if (hash(await readFile(run.candidate.diffPath))!==run.candidate.diffHash) throw new Error('Candidate diff changed');
      const logs = await Promise.all(run.candidate.checks.map(async c=>hash(await readFile(c.log))));
      const evidence = fingerprint({candidate:run.candidate.hash,commit:run.candidate.commit,diff:run.candidate.diffHash,
        checks:run.candidate.checks,logs,review:run.candidate.review});
      if(evidence!==id) throw new Error('Candidate evidence changed');
      this.unchanged(run,version);
      this.store.transaction(()=>{this.store.approve(run,gate,id,process.env.USER??'local-operator');this.store.transition(run,'ready_for_manual_merge');});
    } else {
      this.store.ensureSlot(run.id);
      this.store.transaction(()=>{this.store.approve(run,gate,id,process.env.USER??'local-operator');this.store.transition(run,'implementing');});
      this.launch(run);
    }
  }
  async stop(run: Run, status: 'paused'|'cancelled'|'interrupted'): Promise<void> {
    if (run.status==='cancelled' || run.status==='ready_for_manual_merge') throw new Error('Run is terminal');
    const previous = ['awaiting_input','paused','interrupted','failed'].includes(run.status) ? (run.previous??run.status) : run.status;
    // Persist human stop intent before waiting on native provisioning/deletion.
    // A crash in that wait must preserve pause/cancel, never revive the stage.
    run.previous=previous;run.blocker=`${status}; no automatic continuation`;
    this.store.transaction(()=>{
      if(run.status===status)this.store.save(run);else this.store.transition(run,status);
      if(status==='cancelled'){this.store.revoke(run);this.store.obsoleteRequests(run.id,'Run cancelled');}
    });
    if (this.active?.run.id===run.id) {
      const active=this.active;active.controller.abort();this.answerPending?.reject(new Error('Stage stopped'));this.answerPending=undefined;
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        await Promise.race([
          (async()=>{await active.guest?.close();await active.done;})(),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Workspace termination is unconfirmed after the shutdown grace period; execution remains blocked')),10_000);}),
        ]);
      }catch(e){run.blocker=clean((e as Error).message);this.store.save(run);throw e;}
      finally{clearTimeout(timer);}
    }
  }
  answer(run: Run, request: string, message: string): void {
    const record = this.store.answer(run,request,message);
    this.deliverAnswer(run,record.id,record.stage,message);
  }
  deliverAnswer(run:Run,request:string,stage:Status,message:string):void {
    if (run.status==='awaiting_input' && this.active?.run.id===run.id && !this.active.controller.signal.aborted && this.answerPending?.id===request) {
      this.store.transition(run,stage);this.answerPending.resolve(message);this.answerPending=undefined;
    }
  }
  async resume(run: Run): Promise<void> {
    const version=this.version(run);
    if (!['paused','interrupted','failed','awaiting_input'].includes(run.status)) throw new Error('Run cannot resume');
    if (this.active) throw new Error('Execution already active');
    if (this.store.requests(run.id).some(q=>q.pending)) throw new Error('Resolve the pending question before explicitly resuming');
    await this.context(run);this.store.ensureSlot(run.id);await stopRecordedWorkspaces(this.store,this.owner);
    this.unchanged(run,version);
    if(this.active||this.stopping)throw new Error('Supervisor is executing or stopping');
    const stage = run.previous ?? (run.plan ? 'implementing' : 'planning');
    if(['awaiting_plan_approval','awaiting_merge_approval'].includes(stage)){
      if(stage==='awaiting_merge_approval'&&!this.store.approved(run))throw new Error('Current plan approval required');
      delete run.blocker;this.store.transition(run,stage);return;
    }
    if (!['planning','implementing','repairing','verifying','reviewing'].includes(stage)) throw new Error('Return to an approval gate or revise the plan explicitly');
    if(stage!=='planning' && !this.store.approved(run)) throw new Error('Current plan approval required');
    delete run.blocker;this.store.transition(run,stage);this.launch(run);
  }
  async revise(run: Run, message: string, recorded=false): Promise<void> {
    const version=this.version(run);
    if (!['awaiting_plan_approval','awaiting_merge_approval','failed','paused','interrupted'].includes(run.status) || this.active) throw new Error('Pause or wait for an approval gate before requesting changes');
    await this.configurationCurrent();
    this.store.ensureSlot(run.id);await stopRecordedWorkspaces(this.store,this.owner);
    const fresh = await this.linear.issue(run.issue.identifier);
    if(fresh.id!==run.issue.id) throw new Error('Issue identity changed; cannot revise this run');
    if(run.organizationId){
      if(fresh.organization_id){if(fresh.organization_id!==run.organizationId)throw new Error('Recorded Linear organization changed');}
      else await this.linear.confirmOrganization(run.organizationId);
    }
    const base=await baseCommit(this.config);
    const factoryBuild=await buildHash();
    this.unchanged(run,version);
    if(this.active||this.stopping)throw new Error('Supervisor is executing or stopping');
    this.store.ensureSlot(run.id);
    if(base!==run.base) {
      run.base=base;run.source=(await snapshotRepository(this.config,base,paths(this.root).artifacts)).hash;
      delete run.candidate;
    }
    this.unchanged(run,version);this.store.ensureSlot(run.id);
    if(this.active||this.stopping)throw new Error('Supervisor is executing or stopping');
    run.issue=fresh;run.issueHash=fingerprint(fresh);run.config=this.config;run.configHash=configHash(this.config);run.buildHash=factoryBuild;
    this.store.revoke(run);if(!recorded)run.messages.push({kind:'revision',text:clean(message),time:new Date().toISOString()});
    this.store.obsoleteRequests(run.id,'Plan revision superseded this request');
    delete run.plan;delete run.planHash;delete run.blocker;
    run.repairCount=0;this.store.transition(run,'planning');this.launch(run);
  }
  async steer(run: Run, message: string): Promise<void> {
    if(['cancelled','ready_for_manual_merge'].includes(run.status)) throw new Error('Run is terminal');
    run.messages.push({kind:'steering',text:clean(message),time:new Date().toISOString()});
    this.store.save(run);
    await this.deliverSteering(run,message);
  }
  async deliverSteering(run:Run,message:string):Promise<void> {
    if(this.active?.run.id===run.id && this.active.session) {
      await this.active.session.steer(`Human steering within the existing approved scope only (permissions, path scope, checks, budget unchanged): ${clean(message)}. Ask for a revised plan if this needs expanded scope.`);
    }
  }
}
