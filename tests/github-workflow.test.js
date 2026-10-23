import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('approved GitHub deployment keeps the reviewed commit and survives a restart without replay',{timeout:30000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rahban-github-http-')),providerFile=join(dir,'github.json'),githubCalls=join(dir,'github-calls'),liaraCalls=join(dir,'liara-calls');
  let provider={commit:'a'.repeat(40)},server,output='',csrf,cookie;
  const setProvider=change=>{provider={...provider,...change};writeFileSync(providerFile,JSON.stringify(provider));};setProvider({});writeFileSync(githubCalls,'');writeFileSync(liaraCalls,'');
  const base='http://127.0.0.1:4315';
  const counts=()=>readFileSync(githubCalls,'utf8').trim().split('\n').filter(Boolean);
  async function call(path,method='GET',body){const response=await fetch(base+'/api'+path,{method,headers:{cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};}
  async function start(){
    server=spawn(process.execPath,['--import','./tests/fixtures/liara-fetch.js','--import','./tests/fixtures/github-fetch.js','server/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'4315',HOST:'127.0.0.1',DATA_DIR:dir,RAHBAN_IGNORE_ENV:'1',LIARA_API_TOKEN:'test-only',LLM_API_KEY:'',TEST_RELEASE_FAIL_ONCE:'1',TEST_LIARA_CALLS:liaraCalls,TEST_GITHUB_STATE:providerFile,TEST_GITHUB_CALLS:githubCalls},stdio:'pipe'});
    server.stdout.on('data',value=>output+=value);server.stderr.on('data',value=>output+=value);
    for(let n=0;n<60;n++){try{const response=await fetch(base+'/healthz');if(response.ok){const body=await response.json();assert.equal(response.headers.get('x-rahban-instance'),body.runtime.instanceId);return body.runtime;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.fail(output);
  }
  async function session(){const response=await fetch(base+'/api/session');cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;}
  const stop=async()=>{if(!server)return;const closed=new Promise(resolve=>server.once('close',resolve));server.kill();await closed;server=null;};
  async function waitFor(predicate){for(let n=0;n<100;n++){const state=(await call('/state')).body;const result=predicate(state);if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}assert.fail('State did not settle: '+output);}
  async function approve(proposal){assert.equal(proposal.status,200,JSON.stringify(proposal.body));const result=await call('/approvals/'+proposal.body.id+'/execute','POST',{confirmation:'deploy-test'});assert.equal(result.status,202,JSON.stringify(result.body));return waitFor(state=>state.jobs.find(job=>job.id===result.body.id&&job.status!=='running'));}
  try{
    const initialRuntime=await start();await session();await call('/mode','POST',{mode:'live'});await call('/sync','POST',{});
    const source=await call('/sources/github','POST',{url:'https://github.com/team/app',branch:'main'});assert.equal(source.status,200);assert.equal(source.body.github.commit,provider.commit);
    setProvider({commit:'b'.repeat(40)});
    const proposal=await call('/proposals','POST',{type:'deploy',target:'deploy-test',sourceId:source.body.id,settings:{healthPath:'/healthz'}});
    assert.equal(proposal.status,200,JSON.stringify(proposal.body));
    const providerCalls=()=>readFileSync(liaraCalls,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.equal(providerCalls().filter(call=>call.method==='POST').length,0,'Review must not mutate Liara');
    const submitted=await approve(proposal);assert.equal(submitted.status,'needs_attention');
    const checked=await call('/jobs/'+submitted.id+'/verify','POST',{});assert.equal(checked.status,200);
    const initial=checked.body;assert.equal(initial.status,'succeeded');assert.equal(initial.rahban,initialRuntime.signature);assert.equal(initial.commit,'a'.repeat(40));
    const releases=providerCalls().filter(call=>call.path?.endsWith('/releases'));
    assert.equal(releases.length,1);assert.match(releases[0].body.message,new RegExp(initialRuntime.signature));assert.match(releases[0].body.message,/commit:aaaaaaa/);
    assert.deepEqual(counts(),['reference','archive'],'Execution must use the reviewed archive');
    const deployed=(await call('/state')).body.services.find(service=>service.id==='deploy-test');
    assert.equal(deployed.github.commit,initial.commit);assert.equal(deployed.rahban,initialRuntime.signature);

    await stop();const restarted=await start();assert.equal(restarted.instanceId,initialRuntime.instanceId);assert.notEqual(restarted.bootId,initialRuntime.bootId);assert.equal(restarted.recovered,true);
    assert.equal((await call('/state')).status,401);await session();await call('/mode','POST',{mode:'live'});
    const recovered=(await call('/state')).body;
    assert.equal(recovered.jobs.length,1);assert.equal(recovered.jobs[0].id,initial.id);assert.equal(recovered.jobs[0].status,'succeeded');
    assert.equal(providerCalls().filter(call=>call.path?.endsWith('/releases')).length,1,'Restart must not replay deployment');
    assert.deepEqual(counts(),['reference','archive']);
  }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
