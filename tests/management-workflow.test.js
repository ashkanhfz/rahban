import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const existing=[{key:'KEEP',value:'existing-keep-secret-9371'},{key:'CHANGE',value:'existing-change-secret-5382'},{key:'REMOVE',value:'existing-remove-secret-4726'}];
const newValue='new-environment-secret-8913',addedValue='added-environment-secret-9137',driftValue='manual-environment-secret-6821';
const secrets=[...existing.map(item=>item.value),newValue,addedValue,driftValue,'management-account-token'];

async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'rahban-management-workflow-')),stateFile=join(dir,'provider.json'),callsFile=join(dir,'provider-calls.jsonl');
  writeFileSync(stateFile,JSON.stringify({exists:true,scale:1,envs:existing,deleteUncertain:false}));writeFileSync(callsFile,'');
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/fixtures/management-fetch.js','server/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,RAHBAN_IGNORE_ENV:'1',LIARA_API_TOKEN:'management-account-token',LIARA_TEAM_ID:'management-team',LLM_API_KEY:'',LLM_SHARE_EVIDENCE:'false',PUBLIC_ORIGIN:'',OPERATOR_PASSWORD_HASH:'',TEST_MANAGEMENT_STATE:stateFile,TEST_MANAGEMENT_CALLS:callsFile},stdio:'pipe'});
  const closed=new Promise(resolve=>child.once('close',resolve));let output='',cookie='',csrf='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
  t.after(async()=>{child.kill();await closed;rmSync(dir,{recursive:true,force:true});});
  async function call(path,method='GET',body){const response=await fetch(base+'/api'+path,{method,headers:{cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
  let ready=false;for(let n=0;n<80;n++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,output);
  const session=await fetch(base+'/api/session');cookie=session.headers.get('set-cookie').split(';')[0];csrf=(await session.json()).csrf;
  assert.equal((await call('/mode','POST',{mode:'live'})).status,200);assert.equal((await call('/sync','POST',{})).body.count,1);
  const calls=()=>readFileSync(callsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const writes=()=>calls().filter(row=>row.method&&row.method!=='GET');
  const provider=()=>JSON.parse(readFileSync(stateFile,'utf8'));
  const configure=change=>writeFileSync(stateFile,JSON.stringify({...provider(),...change}));
  async function settled(id){for(let n=0;n<240;n++){const job=(await call('/state')).body.jobs.find(row=>row.id===id);if(job&&job.status!=='running')return job;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail('Management job did not settle: '+output);}
  async function propose(type,extra={}){const result=await call('/proposals','POST',{type,target:'management-test',...extra});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}
  async function execute(approval){const result=await call('/approvals/'+approval.id+'/execute','POST',{confirmation:'management-test'});assert.equal(result.status,202,JSON.stringify(result.body));return settled(result.body.id);}
  function persisted(){const db=new DatabaseSync(join(dir,'rahban.sqlite'),{readOnly:true});try{return {records:db.prepare('SELECT kind,body FROM records').all(),approvals:db.prepare('SELECT * FROM approvals').all(),audit:db.prepare('SELECT body FROM audit').all()};}finally{db.close();}}
  function addCompletedChecks(job,count){
    const db=new DatabaseSync(join(dir,'rahban.sqlite'));
    try{const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?)');for(let n=0;n<count;n++){const row={id:'completed-check-'+n,created:new Date(Date.now()+n+1).toISOString(),type:'check',target:job.target,mode:job.mode,accountScope:job.accountScope,status:'succeeded'};insert.run(row.id,'job',JSON.stringify(row),row.created);}}
    finally{db.close();}
  }
  function noSecrets(value){const text=typeof value==='string'?value:JSON.stringify(value);for(const secret of secrets)assert.ok(!text.includes(secret),'Secret escaped: '+secret);}
  function storageHasNoSecrets(){noSecrets(persisted());for(const suffix of ['','-wal','-shm']){const path=join(dir,'rahban.sqlite'+suffix);if(existsSync(path))noSecrets(readFileSync(path).toString('latin1'));}}
  return {call,calls,writes,provider,configure,propose,execute,settled,persisted,addCompletedChecks,noSecrets,storageHasNoSecrets};
}

test('environment changes require approval, preserve untouched values and keep secrets out of responses and storage',{timeout:25000},async t=>{
  const f=await fixture(t),configuration=await f.call('/services/management-test/configuration');
  assert.equal(configuration.status,200);assert.deepEqual(configuration.body.envKeys,['CHANGE','KEEP','REMOVE']);f.noSecrets(configuration.body);
  const approval=await f.propose('update-env',{changes:{updates:[{key:'CHANGE',value:newValue},{key:'ADD',value:addedValue}],remove:['REMOVE']}});
  assert.deepEqual(approval.payload.updatedKeys,['CHANGE','ADD']);assert.deepEqual(approval.payload.removedKeys,['REMOVE']);f.noSecrets(approval);f.storageHasNoSecrets();assert.equal(f.writes().length,0);
  assert.equal((await f.call('/approvals/'+approval.id+'/execute','POST',{confirmation:'wrong-app'})).status,400);assert.equal(f.writes().length,0);
  const job=await f.execute(approval);assert.equal(job.status,'succeeded',JSON.stringify(job));
  const update=f.writes();assert.equal(update.length,1);assert.equal(update[0].path,'/v1/projects/update-envs');assert.equal(update[0].body.project,'management-test');
  assert.deepEqual(update[0].body.variables,[existing[0],{key:'CHANGE',value:newValue},{key:'ADD',value:addedValue}]);assert.deepEqual(f.provider().envs,update[0].body.variables);
  assert.equal((await f.call('/approvals/'+approval.id+'/execute','POST',{confirmation:'management-test'})).status,400);assert.equal(f.writes().length,1,'A consumed approval must never replay the update');
  f.noSecrets((await f.call('/state')).body);f.storageHasNoSecrets();

  const stale=await f.propose('update-env',{changes:{updates:[{key:'CHANGE',value:'next-value-not-submitted'}],remove:[]}});
  f.configure({envs:f.provider().envs.map(item=>item.key==='KEEP'?{...item,value:driftValue}:item)});
  const rejected=await f.execute(stale);assert.equal(rejected.status,'failed');assert.match(rejected.message,/configuration changed/i);assert.equal(f.writes().length,1,'Configuration drift must fail before the replacement write');
  f.noSecrets((await f.call('/state')).body);f.storageHasNoSecrets();
});

test('start and stop are separate explicitly approved writes, verified against Liara state',{timeout:25000},async t=>{
  const f=await fixture(t),stop=await f.propose('stop-app');assert.equal(f.writes().length,0);
  const stopped=await f.execute(stop);assert.equal(stopped.status,'succeeded',JSON.stringify(stopped));assert.equal(f.provider().scale,0);
  assert.equal(f.calls().filter(row=>row.probe).length,0,'A deliberately stopped app is verified through Liara, not a successful HTTP probe');
  const start=await f.propose('start-app');assert.equal(f.writes().length,1);const started=await f.execute(start);assert.equal(started.status,'succeeded',JSON.stringify(started));assert.equal(f.provider().scale,1);
  assert.deepEqual(f.writes().map(row=>({path:row.path,body:row.body})),[{path:'/v1/projects/management-test/actions/scale',body:{scale:0}},{path:'/v1/projects/management-test/actions/scale',body:{scale:1}}]);
  f.storageHasNoSecrets();
});

test('environment verification failures keep echoed values out of jobs, API errors and storage',{timeout:10000},async t=>{
  const f=await fixture(t),approval=await f.propose('update-env',{changes:{updates:[{key:'CHANGE',value:newValue}],remove:[]}});
  f.configure({afterEnvUpdateError:true});const job=await f.execute(approval);
  assert.equal(job.status,'needs_attention');assert.equal(job.failure.stage,'Provider state verification');assert.equal(job.failure.status,400);assert.ok(!job.failure.providerMessage);f.noSecrets(job);
  const verification=await f.call('/jobs/'+job.id+'/verify','POST',{});assert.equal(verification.status,400);assert.match(verification.body.error,/could not confirm the environment change/);f.noSecrets(verification.body);
  assert.equal(f.writes().length,1,'Verification errors must not replay environment writes');f.noSecrets((await f.call('/state')).body);f.storageHasNoSecrets();
});

test('uncertain deletion needs read-only verification before history removal and never repeats the delete',{timeout:15000},async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/services/management-test/monitor','POST',{enabled:true,intervalMinutes:60})).status,200);
  const approval=await f.propose('delete-app');assert.equal(approval.risk,'high');assert.match(approval.impact,/delete|storage/i);assert.equal(f.writes().length,0);
  f.configure({deleteUncertain:true});const uncertain=await f.execute(approval);assert.equal(uncertain.status,'needs_attention',JSON.stringify(uncertain));assert.equal(f.provider().exists,false);
  assert.equal((await f.call('/jobs/'+uncertain.id,'DELETE')).status,409);assert.equal((await f.call('/approvals/'+approval.id+'/execute','POST',{confirmation:'management-test'})).status,400);assert.equal(f.writes().length,1);
  f.addCompletedChecks(uncertain,110);
  assert.ok((await f.call('/state')).body.jobs.some(row=>row.id===uncertain.id),'Uncertain operations remain accessible beyond the recent history limit');
  const duplicate=await f.propose('delete-app'),blocked=await f.call('/approvals/'+duplicate.id+'/execute','POST',{confirmation:'management-test'});
  assert.ok(blocked.status>=400&&blocked.status<500);assert.match(blocked.body.error,/unconfirmed|verify/i);assert.equal(f.writes().length,1,'A fresh approval must not bypass the earlier uncertain deletion');
  const verified=await f.call('/jobs/'+uncertain.id+'/verify','POST',{});assert.equal(verified.status,200,JSON.stringify(verified.body));assert.equal(verified.body.status,'succeeded');assert.equal(f.writes().length,1,'Verification must query state without another DELETE');
  assert.equal((await f.call('/state')).body.services.length,0);
  const storedBefore=f.persisted(),originalApproval=storedBefore.approvals.find(row=>row.id===approval.id);
  assert.equal(storedBefore.approvals.find(row=>row.id===duplicate.id).status,'rejected','Deletion invalidates pending approvals for the deleted app');
  assert.equal((await f.call('/approvals/'+duplicate.id+'/execute','POST',{confirmation:'management-test'})).status,400);assert.equal(f.writes().length,1);
  for(const row of storedBefore.records.filter(row=>['monitor','continuous'].includes(row.kind)))assert.equal(JSON.parse(row.body).enabled,false,'Deleted apps must stop scheduled work');
  assert.deepEqual((await f.call('/jobs/'+uncertain.id,'DELETE')).body,{ok:true});assert.ok(!(await f.call('/state')).body.jobs.some(row=>row.id===uncertain.id));
  const storedAfter=f.persisted(),job=storedAfter.records.filter(row=>row.kind==='job').map(row=>JSON.parse(row.body)).find(row=>row.id===uncertain.id);
  assert.equal(job.hidden,true);assert.equal(job.status,'succeeded');assert.equal(job.approvalId,approval.id);assert.deepEqual(storedAfter.approvals.find(row=>row.id===approval.id),originalApproval);
  assert.ok(storedAfter.audit.some(row=>JSON.parse(row.body).event==='history.removed'));assert.equal(f.writes().filter(row=>row.method==='DELETE').length,1);f.storageHasNoSecrets();
});
