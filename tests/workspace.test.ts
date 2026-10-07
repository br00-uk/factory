import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, paths } from '../src/config.js';
import { atomicWrite, command, hash, hostEnvironment, privateDirectory, requireSuccess } from '../src/safety.js';
import { git } from '../src/git.js';
import { fixtureConfig, fixtureRun, issue } from './fixtures.js';
import type { Run } from '../src/models.js';
import { Store } from '../src/storage.js';
import { send } from '../src/control.js';

// Actual Herdr and foreground supervisor/operator processes, with an explicit
// offline Linear fixture. This does not authenticate or mutate a live account.
test('Makefile workspace runs a fixture task through Pi human gates, reuses startup, and preserves unrelated panes and saved state',
  {timeout:240000},async()=>{
    assert.equal(process.env.HERDR_ENV,'1','Workspace acceptance requires running make check inside Herdr');
    const root=await realpath(await mkdtemp(join(tmpdir(),'factory-workspace-')));const repository=join(root,'target');
    const p=paths(root);await privateDirectory(repository);
    for(const dir of [p.state,p.artifacts,p.sessions,p.tools])await privateDirectory(dir);
    for(const file of ['package.json','package-lock.json','tsconfig.json','Makefile'])await copyFile(join(ROOT,file),join(root,file));
    for(const dir of ['src','dist/src','scripts','pi-extension'])await cp(join(ROOT,dir),join(root,dir),{recursive:true});
    await symlink(join(ROOT,'node_modules'),join(root,'node_modules'));
    await copyFile(join(paths(ROOT).tools,'herdr'),join(p.tools,'herdr'));
    await copyFile(join(paths(ROOT).tools,'herdr.pin'),join(p.tools,'herdr.pin'));
    await copyFile(join(paths(ROOT).tools,'smol'),join(p.tools,'smol'));
    await copyFile(join(paths(ROOT).tools,'smol.pin'),join(p.tools,'smol.pin'));
    await git(repository,['init','--initial-branch=main','--quiet']);
    await writeFile(join(repository,'value.txt'),'old\n');
    await writeFile(join(repository,'check.py'),'from pathlib import Path\nassert Path("value.txt").read_text().strip() in ("old", "new")\n');
    await git(repository,['add','value.txt','check.py']);
    await git(repository,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--quiet','-m','base']);
    const config=fixtureConfig(repository);config.model={provider:'openai',id:'gpt-4.1',apiKeyEnv:'FACTORY_WORKSPACE_FIXTURE_KEY',maxOutputTokens:4096};
    await atomicWrite(p.config,JSON.stringify(config));await atomicWrite(join(p.state,'image.json'),JSON.stringify({image:config.environment.image}));
    const fixtureFile=join(root,'linear-fixture.json');
    const selected={...issue,id:'9a0e0000-0000-4000-8000-000000000043',identifier:'ENG-43',url:issue.url.replace('ENG-42','ENG-43')};
    const linear=`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--version')console.log('linear-tui 0.13.0');
else if(args[0]==='auth'&&args[1]==='status')console.log('Authenticated (OFFLINE FIXTURE)');
else if(args[0]==='context')console.log(fs.readFileSync(${JSON.stringify(fixtureFile)},'utf8'));
else if(args[0]==='issue'&&args[1]==='show'&&args[2]==='ENG-43')console.log(${JSON.stringify(JSON.stringify(selected))});
else if(!args.length){console.log('OFFLINE LINEAR FIXTURE — no live account');setInterval(()=>{},1000);}
else process.exit(2);
`;
    await writeFile(join(p.tools,'linear-tui'),linear,{mode:0o700});await atomicWrite(join(p.tools,'linear-tui.pin'),hash(linear));
    const fixture={workspace:repository,running:true,snapshot:{version:1,organization:{id:'ab120000-0000-4000-8000-000000000001',url_key:config.linear.organization},
      screen:'issue_list',rows:[{kind:'issue',id:selected.id,identifier:selected.identifier}],selected_row:0}};
    await atomicWrite(fixtureFile,JSON.stringify(fixture));
    // Only this private copied installation substitutes a trusted fixture role
    // function. Runtime config and target files cannot select host agents.
    await writeFile(join(root,'dist/workspace-agent.js'),`export async function fixtureAgent(role,guest){
      if(role==='planner')return JSON.stringify({summary:'Fixture change',paths:['value.txt'],acceptance:['value is new'],steps:['Write new value']});
      if(role==='implementer'){await guest.write('value.txt','new\\n');return 'Done';}
      return JSON.stringify({findings:[],acceptance:[{criterion:'value is new',passed:(await guest.read('value.txt')).trim()==='new',evidence:'Read frozen source in the verification VM'}]});
    }`);
    // make up builds the private copy from source, including this explicit
    // trusted fixture injection, rather than bypassing the Makefile contract.
    const sourceCli=join(root,'src/cli.ts');
    const cli=await readFile(sourceCli,'utf8');assert.ok(cli.includes('await serve(ROOT,config);'));
    await writeFile(sourceCli,cli.replace('await serve(ROOT,config);',"await serve(ROOT,config,(await import('../workspace-agent.js')).fixtureAgent);"));
    await writeFile(join(root,'workspace-agent.d.ts'),"export const fixtureAgent: typeof import('./src/pi.js').runAgent;\n");
    const env=hostEnvironment({HERDR_ENV:'1',HERDR_SOCKET_PATH:process.env.HERDR_SOCKET_PATH??'',FACTORY_WORKSPACE_FIXTURE_KEY:'offline-fixture-no-model-request'});
    const make=(target:string)=>command(['/usr/bin/make','-C',root,target],{env,timeoutMs:45000,maxBytes:1024*1024});
    const herdr=async(args:string[])=>{
      const output=requireSuccess(await command([join(p.tools,'herdr'),...args],{env})).toString();
      return output.trim()?JSON.parse(output).result:undefined;
    };
    const store=new Store(p.state);const run=fixtureRun(config);run.status='paused';run.previous='planning';store.create(run);
    store.request({id:'Q-0123456789ab',run:run.id,stage:'planning',context:run.source,question:'Saved fixture question',pending:true,created:run.created});store.close();
    let workspace:{id:string;supervisor:string;linear:string;operator:string}|undefined;let extra:string|undefined;
    try{
      const first=await make('up');assert.equal(first.code,0,first.stderr.toString()+first.stdout.toString());
      workspace=JSON.parse(await readFile(join(p.state,'workspace.json'),'utf8'));
      const health=await send({command:'health'},root) as {pid:number};
      const repeat=await make('up');assert.equal(repeat.code,0,repeat.stderr.toString());
      assert.equal((await send({command:'health'},root) as {pid:number}).pid,health.pid,'Repeated up reuses the actual foreground process');
      const recorded=JSON.parse(await readFile(join(p.state,'workspace.json'),'utf8'));assert.equal(recorded.id,workspace!.id);
      assert.equal((await send({command:'status'},root) as {status:string}[])[0]!.status,'paused','Up never starts or resumes a task');
      const waitRun=async(status:string):Promise<Run>=>{
        const deadline=Date.now()+60000;
        for(;;){
          const runs=await send({command:'status'},root) as {id:string;issue:string;status:string;blocker?:string}[];
          const current=runs.find(r=>r.issue==='ENG-43');
          if(current?.status===status)return (await send({command:'status',run:current.id},root) as Run[])[0]!;
          if(current?.status==='failed')throw new Error(current.blocker??'Fixture task failed');
          if(Date.now()>deadline)throw new Error(`Fixture operator command did not reach ${status}: ${JSON.stringify(current)}`);
          await new Promise(resolve=>setTimeout(resolve,250));
        }
      };
      await herdr(['agent','prompt',workspace!.operator,'/factory plan current']);
      const planned=await waitRun('awaiting_plan_approval');assert.equal(planned.issue.id,selected.id);
      await herdr(['agent','prompt',workspace!.operator,`/factory approve ${planned.id} --plan ${planned.planHash}`]);
      const candidate=await waitRun('awaiting_merge_approval');
      assert.ok(candidate.candidate!.checks.every(c=>c.outcome==='passed'));assert.equal(candidate.repairCount,0);
      await herdr(['agent','prompt',workspace!.operator,`/factory approve ${candidate.id} --candidate ${candidate.candidate!.evidenceHash}`]);
      const ready=await waitRun('ready_for_manual_merge');
      assert.equal(await readFile(join(repository,'value.txt'),'utf8'),'old\n','The Herdr workflow leaves the original checkout unchanged');
      assert.equal((await git(ready.candidate!.repository,['show',`${ready.candidate!.commit}:value.txt`])).toString(),'new\n');
      assert.match((ready as Run&{integration:string}).integration,/git fetch/);
      config.limits.maxTurns++;await atomicWrite(p.config,JSON.stringify(config));
      await assert.rejects(send({command:'plan',issue:'ENG-42'},root),/Supervisor configuration changed/,'A live supervisor cannot start work using settings superseded on disk');
      const changed=await make('up');assert.notEqual(changed.code,0);assert.match(changed.stderr.toString(),/configuration changed/);
      assert.equal((await send({command:'health'},root) as {pid:number}).pid,health.pid,'Configuration mismatch preserves the existing owned installation for explicit down');
      const split=await herdr(['pane','split','--pane',workspace!.linear,'--direction','down','--cwd',repository,'--no-focus']);extra=split.pane.pane_id;
      const stopped=await make('down');assert.equal(stopped.code,0,stopped.stderr.toString());
      const panes=(await herdr(['pane','list','--workspace',workspace!.id])).panes as {pane_id:string}[];
      assert.ok(panes.some(pane=>pane.pane_id===extra),'Down preserves a pane outside the factory ownership record');
      assert.ok(panes.every(pane=>![workspace!.supervisor,workspace!.linear,workspace!.operator].includes(pane.pane_id)));
      await assert.rejects(lstat(p.socket),{code:'ENOENT'});
      const saved=new Store(p.state);assert.equal(saved.get(run.id).status,'paused');assert.equal(saved.requests(run.id)[0]!.pending,true);
      assert.equal(saved.get(ready.id).status,'ready_for_manual_merge');assert.equal(saved.unresolvedVMs().length,0);saved.close();
      await herdr(['pane','close',extra!]);extra=undefined;workspace=undefined;
      fixture.running=false;await atomicWrite(fixtureFile,JSON.stringify(fixture));
      const failed=await make('up');assert.notEqual(failed.code,0);assert.match(failed.stderr.toString(),/Linear TUI readiness failed/);
      await assert.rejects(lstat(join(p.state,'workspace.json')),{code:'ENOENT'});
      await assert.rejects(lstat(p.socket),{code:'ENOENT'});
      const afterFailure=new Store(p.state);assert.equal(afterFailure.get(run.id).status,'paused');afterFailure.close();
      console.log('Herdr/Makefile workspace acceptance used OFFLINE Linear credentials; no live task or model request.');
    }finally{
      const cleanup=await make('down');
      assert.equal(cleanup.code,0,`Workspace cleanup failed; retained ${root}: ${cleanup.stderr.toString()}`);
      if(extra)await herdr(['pane','close',extra]).catch(()=>undefined);
      // Production down already removes only the three recorded panes. Do not
      // close a whole workspace which may now contain another operator pane.
      await rm(root,{recursive:true,force:true});
    }
  });
