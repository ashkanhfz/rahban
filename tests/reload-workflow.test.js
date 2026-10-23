import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.js';

const token='reload-fixture-token',team='reload-team';
const scope=createHash('sha256').update(JSON.stringify([token,team])).digest('hex');

async function fixture(t,seed=()=>{}){
  const dir=mkdtempSync(join(tmpdir(),'rahban-reload-')),store=openStore(dir);
  seed(store);
  const guard=join(dir,'fetch-guard.mjs');
  writeFileSync(guard,`const original=globalThis.fetch;globalThis.fetch=(input,init)=>{if(new URL(input).hostname!=='127.0.0.1')throw new Error('Unexpected external request');return original(input,init);};`);
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const base=`http://127.0.0.1:${port}`;let child,closed,output='',cookie='',csrf='';
  async function call(path,method='GET',body){
    const response=await fetch(base+'/api'+path,{method,headers:{cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  async function start(){
    child=spawn(process.execPath,['--import',guard,'server/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,RAHBAN_IGNORE_ENV:'1',LIARA_API_TOKEN:token,LIARA_TEAM_ID:team,LLM_API_KEY:'',LLM_SHARE_EVIDENCE:'false',PUBLIC_ORIGIN:'',OPERATOR_PASSWORD_HASH:''},stdio:'pipe'});
    closed=new Promise(resolve=>child.once('close',resolve));child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
    let ready=false;for(let n=0;n<80;n++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,25));}assert.ok(ready,output);
    const session=await fetch(base+'/api/session');cookie=session.headers.get('set-cookie').split(';')[0];csrf=(await session.json()).csrf;
  }
  async function stop(){if(child){child.kill();await closed;child=null;}}
  const persisted=()=>({records:store.db.prepare("SELECT id,kind,body FROM records WHERE kind<>'runtime' ORDER BY id").all(),approvals:store.db.prepare('SELECT * FROM approvals ORDER BY id').all(),audit:store.db.prepare('SELECT * FROM audit ORDER BY seq').all()});
  t.after(async()=>{await stop();store.db.close();rmSync(dir,{recursive:true,force:true});});
  await start();return {dir,base,call,start,stop,persisted};
}

test('source reload survives restart, verifies saved bytes and never returns archive content',{timeout:10000},async t=>{
  const f=await fixture(t),imported=await f.call('/sources/sample','POST',{});assert.equal(imported.status,200);
  const source=imported.body,path=join(f.dir,'sources',source.id+'.tar.gz'),bytes=readFileSync(path);
  await f.stop();await f.start();
  const before=f.persisted(),restored=await f.call('/sources/'+source.id);
  assert.equal(restored.status,200);assert.deepEqual(restored.body,source);assert.deepEqual(f.persisted(),before,'Reading metadata must not create records, approvals or audit events');
  assert.ok(!JSON.stringify(restored.body).includes('http.createServer'));assert.ok(!('files' in restored.body));assert.ok(!('archive' in restored.body));
  const anonymous=await fetch(f.base+'/api/sources/'+source.id);assert.equal(anonymous.status,401);
  assert.equal((await f.call('/sources/not-a-uuid')).status,400);
  const missing=await f.call('/sources/'+randomUUID());assert.equal(missing.status,404);assert.equal(missing.body.code,'SOURCE_NOT_FOUND');

  writeFileSync(path,Buffer.from('corrupted-local-archive'));
  const corrupt=await f.call('/sources/'+source.id);assert.equal(corrupt.status,409);assert.equal(corrupt.body.code,'SOURCE_CHANGED');
  assert.ok(!JSON.stringify(corrupt.body).includes('corrupted-local-archive'));
  rmSync(path);const absent=await f.call('/sources/'+source.id);assert.equal(absent.status,404);assert.equal(absent.body.code,'SOURCE_ARCHIVE_MISSING');assert.ok(!JSON.stringify(absent.body).includes(f.dir));
  writeFileSync(path,bytes);
  await f.call('/settings','POST',{team:'another-team'});await f.call('/mode','POST',{mode:'live'});
  assert.deepEqual((await f.call('/sources/'+source.id)).body,source,'Local imported sources are not tied to a Liara account');
});

test('job deep links include old history but hide missing, removed, wrong-mode and other-account operations',{timeout:10000},async t=>{
  const approvalId=randomUUID(),makeJob=extra=>({id:randomUUID(),type:'deploy',target:'saved-app',status:'succeeded',steps:[],created:'2024-01-01T00:00:00.000Z',mode:'live',accountScope:scope,...extra});
  const old=makeJob({approvalId}),hidden=makeJob({hidden:true}),foreign=makeJob({accountScope:'another-account'}),legacy=makeJob({accountScope:undefined}),demo=makeJob({mode:'demo'});
  const f=await fixture(t,store=>{
    for(const job of [old,hidden,foreign,legacy,demo])store.put('job',job);
    for(let n=0;n<110;n++)store.put('job',makeJob({type:'check',created:new Date(Date.UTC(2025,0,1,0,0,n)).toISOString()}));
    store.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?)').run(approvalId,JSON.stringify({id:approvalId,payload:{privateDraft:'approval-only-canary'}}),'succeeded',Date.now()+60000,'fixture-context');
  });
  assert.equal((await f.call('/jobs/'+old.id)).status,404,'Live operations are hidden in demo mode');
  assert.deepEqual((await f.call('/jobs/'+demo.id)).body,demo);
  await f.call('/mode','POST',{mode:'live'});
  const state=(await f.call('/state')).body;assert.equal(state.jobs.length,100);assert.ok(!state.jobs.some(job=>job.id===old.id));
  const before=f.persisted(),restored=await f.call('/jobs/'+old.id);assert.equal(restored.status,200);assert.deepEqual(restored.body,old);
  assert.ok(!('payload' in restored.body));assert.ok(!JSON.stringify(restored.body).includes('approval-only-canary'));
  const absent=await f.call('/jobs/'+randomUUID());assert.equal(absent.status,404);assert.equal(absent.body.code,'JOB_NOT_FOUND');
  for(const job of [hidden,foreign,legacy,demo])assert.deepEqual(await f.call('/jobs/'+job.id),absent);
  assert.deepEqual(f.persisted(),before,'Deep-link reads must not execute or update an operation');
  const anonymous=await fetch(f.base+'/api/jobs/'+old.id);assert.equal(anonymous.status,401);
  const changed=await f.call('/settings','POST',{team:'another-team'});
  assert.equal(changed.status,200);assert.match(state.settings.connectionId,/^[0-9a-f-]{36}$/);assert.notEqual(changed.body.connectionId,state.settings.connectionId);
  assert.equal((await f.call('/state')).body.settings.connectionId,changed.body.connectionId);
  assert.ok(!JSON.stringify(changed.body).includes(token));assert.ok(!('token' in changed.body));
  assert.deepEqual(await f.call('/jobs/'+old.id),absent,'Changing the connected team must immediately hide prior jobs');
});
