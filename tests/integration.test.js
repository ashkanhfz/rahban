import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('HTTP workflow: fail -> diagnose -> gate -> restore -> three passing checks; CSRF and replay rejected',{timeout:45000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rahban-http-'));
  const server=spawn(process.execPath,['server/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'4313',HOST:'127.0.0.1',DATA_DIR:dir,RAHBAN_IGNORE_ENV:'1',LIARA_API_TOKEN:'',LLM_API_KEY:''},stdio:'pipe'});
  let output='';server.stdout.on('data',d=>output+=d);server.stderr.on('data',d=>output+=d);
  const base='http://127.0.0.1:4313';let csrf,cookie;
  async function call(path,method='GET',body){const r=await fetch(base+'/api'+path,{method,headers:{cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
  try{
    let ready=false;for(let n=0;n<60;n++){try{const r=await fetch(base+'/healthz');if(r.ok){assert.equal(r.headers.get('referrer-policy'),'same-origin');ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,150));}assert.ok(ready,output);
    const session=await fetch(base+'/api/session');cookie=session.headers.get('set-cookie').split(';')[0];csrf=(await session.json()).csrf;
    const noCsrf=await fetch(base+'/api/demo/fault',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'error'})});assert.equal(noCsrf.status,403);
    const badOrigin=await fetch(base+'/api/session',{headers:{Origin:'https://attacker.example'}});assert.equal(badOrigin.status,403);
    assert.equal((await call('/demo/fault','POST',{type:'error'})).status,200);
    const fail=await call('/probe/sandbox-store','POST',{});assert.equal(fail.body.code,503);assert.equal(fail.body.ok,0);
    const incident=await call('/incidents','POST',{target:'sandbox-store',message:'site broken'});assert.equal(incident.body.status,'open');assert.match(incident.body.hypotheses[0].evidence,/DEMO_CONFIG_INVALID/);
    const approval=await call('/proposals','POST',{type:'restore-demo',target:'sandbox-store'});assert.equal(approval.status,200);
    const wrong=await call('/approvals/'+approval.body.id+'/execute','POST',{confirmation:'wrong-service'});assert.equal(wrong.status,400);
    const executed=await call('/approvals/'+approval.body.id+'/execute','POST',{confirmation:'sandbox-store'});assert.equal(executed.status,202);
    const replay=await call('/approvals/'+approval.body.id+'/execute','POST',{confirmation:'sandbox-store'});assert.equal(replay.status,400);
    let state;for(let n=0;n<30;n++){state=(await call('/state')).body;if(state.jobs.find(j=>j.id===executed.body.id)?.status==='succeeded')break;await new Promise(r=>setTimeout(r,250));}
    assert.equal(state.jobs.find(j=>j.id===executed.body.id).status,'succeeded');assert.equal(state.incidents.find(i=>i.id===incident.body.id).status,'resolved');
    const metric=await fetch(base+'/metrics').then(r=>r.text());assert.match(metric,/rahban_operations_total\{type="restore-demo",result="succeeded"\} 1/);
    const source=await call('/sources/sample','POST',{});assert.equal(source.body.ready,true);
    const badLive=await call('/proposals','POST',{type:'restart',target:'sandbox-store'});assert.equal(badLive.status,400);
  }finally{server.kill();await new Promise(r=>server.once('close',r));rmSync(dir,{recursive:true,force:true});}
});
