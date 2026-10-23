import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('first Docker deployment preserves approved settings from proposal through release and later health checks',{timeout:20000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rahban-deploy-')),callsFile=join(dir,'calls.jsonl');
  const server=spawn(process.execPath,['--import','./tests/fixtures/liara-fetch.js','server/index.js'],{
    cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'4314',HOST:'127.0.0.1',DATA_DIR:dir,RAHBAN_IGNORE_ENV:'1',LIARA_API_TOKEN:'test-only',LLM_API_KEY:'',TEST_LIARA_CALLS:callsFile,TEST_RELEASE_FAIL_ONCE:'1'},stdio:'pipe',
  });
  let output='';server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);
  const base='http://127.0.0.1:4314';let csrf,cookie;
  const calls=()=>readFileSync(callsFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  async function call(path,method='GET',body){const r=await fetch(base+'/api'+path,{method,headers:{cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
  async function completed(id){
    for(let n=0;n<60;n++){
      const job=(await call('/state')).body.jobs.find(job=>job.id===id);
      if(job&&job.status!=='running')return job;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.fail('Job did not finish: '+output);
  }
  try{
    let ready=false;for(let n=0;n<60;n++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,output);
    const session=await fetch(base+'/api/session');cookie=session.headers.get('set-cookie').split(';')[0];csrf=(await session.json()).csrf;
    await call('/mode','POST',{mode:'live'});
    const source=(await call('/sources/sample','POST',{})).body;
    const create=(await call('/proposals','POST',{type:'create-app',target:'deploy-test',platform:source.platform,planID:'small',bundlePlanID:'basic'})).body;
    assert.equal(create.payload.platform,'docker');assert.equal(create.cost.monthlyEstimate,720);
    assert.ok(!calls().some(c=>c.method==='POST'));
    const created=await call('/approvals/'+create.id+'/execute','POST',{confirmation:'deploy-test'});
    assert.equal(created.status,202);assert.equal((await completed(created.body.id)).status,'succeeded');

    const settings={port:8080,healthPath:'/healthz',healthTimeoutMs:7000,buildCache:false};
    const proposal=await call('/proposals','POST',{type:'deploy',target:'deploy-test',sourceId:source.id,settings});
    assert.equal(proposal.status,200);assert.deepEqual(proposal.body.payload.settings,settings);
    assert.ok(!calls().some(c=>c.path.endsWith('/sources')));
    const executed=await call('/approvals/'+proposal.body.id+'/execute','POST',{confirmation:'deploy-test',settings:{port:1,healthPath:'/'}});
    assert.equal(executed.status,202);const uncertain=await completed(executed.body.id);
    assert.equal(uncertain.status,'needs_attention');assert.deepEqual(uncertain.settings,settings);
    const verified=await call('/jobs/'+uncertain.id+'/verify','POST',{});
    assert.equal(verified.status,200);assert.equal(verified.body.status,'succeeded');
    const release=calls().find(c=>c.path?.endsWith('/releases')).body;
    assert.equal(release.port,8080);assert.equal(release.type,'docker');
    assert.deepEqual(release.build,{cache:false,dockerfile:'Dockerfile'});assert.ok(!('envs' in release));
    assert.equal(calls().filter(c=>c.probe==='/healthz').length,3);
    const state=(await call('/state')).body;
    assert.deepEqual(state.services.find(service=>service.id==='deploy-test').settings,settings);
    const probe=await call('/probe/deploy-test','POST',{});assert.equal(probe.body.ok,1);
    assert.equal(calls().filter(c=>c.probe==='/healthz').length,4);
  }finally{server.kill();await new Promise(r=>server.once('close',r));rmSync(dir,{recursive:true,force:true});}
});
