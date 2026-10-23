import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('retry restores approved inputs, requires fresh approval, and blocks uncertain or cross-account releases',{timeout:30000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rahban-retry-')),controlFile=join(dir,'provider.json'),callsFile=join(dir,'calls.jsonl'),fixture=join(dir,'fetch.mjs');
  let server,output='',cookie,csrf;
  const available=createServer();await new Promise(resolve=>available.listen(0,'127.0.0.1',resolve));const port=available.address().port;await new Promise(resolve=>available.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  let control={projects:[],networks:[{_id:'network-test',name:'Default'}],release:'FAILED',delayUpload:false};
  const configure=change=>{control={...JSON.parse(readFileSync(controlFile,'utf8')),...change};writeFileSync(controlFile,JSON.stringify(control));};
  writeFileSync(controlFile,JSON.stringify(control));writeFileSync(callsFile,'');
  writeFileSync(fixture,`
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const original=globalThis.fetch;
const originalTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,ms,...args)=>originalTimeout(callback,ms===2000?5:ms,...args);
globalThis.fetch=async(input,init={})=>{
 const url=new URL(input),state=JSON.parse(readFileSync(process.env.RETRY_CONTROL,'utf8'));
 if(url.origin==='https://api.liara.ir'){
  const body=typeof init.body==='string'?JSON.parse(init.body):null;
  appendFileSync(process.env.RETRY_CALLS,JSON.stringify({path:url.pathname,method:init.method||'GET',body})+'\\n');
  if(url.pathname==='/v1/me')return Response.json({plans:{projects:{small:{available:true,price:2,RAM:{amount:.5},CPU:{amount:.5}}},projectBundlePlans:{small:{basic:{available:true,displayPrice:400}}}}});
  if(url.pathname==='/v1/networks')return state.networkError?Response.json({},{status:state.networkError}):Response.json({networks:state.networks});
  if(url.pathname==='/v1/projects')return Response.json({projects:state.projects});
  if(url.pathname==='/v1/projects/'){
   if(body.name==='name-taken')return Response.json({message:'Name is already taken. token=test-account-one; password=do-not-show'},{status:409});
   state.projects.push({project_id:body.name,type:body.platform,status:'created'});writeFileSync(process.env.RETRY_CONTROL,JSON.stringify(state));return Response.json({});
  }
  if(url.pathname.endsWith('/sources')){if(state.uploadError)return Response.json({error:{message:'Archive format is not supported'}},{status:400});if(state.delayUpload)await new Promise(resolve=>setTimeout(resolve,150));return Response.json({sourceID:'source-test'});}
  if(url.pathname.endsWith('/releases'))return state.release==='WRITE_UNCERTAIN'?Response.json({},{status:503}):Response.json({releaseID:'release-test'});
  if(url.pathname==='/v1/releases/release-test')return state.release==='READ_UNCERTAIN'?Response.json({},{status:503}):Response.json({release:{state:state.release}});
  if(url.pathname.startsWith('/v1/projects/'))return Response.json({project:{envs:[],disks:state.diskAttached?[{name:'data'}]:[]}});
  throw new Error('Unexpected Liara request');
 }
 if(url.hostname==='retry-ok.liara.run')return new Response('fixture health',{status:state.healthCode||200});
 if(url.hostname!=='127.0.0.1')throw new Error('Unexpected external request');
 return original(input,init);
};
`);
  const calls=()=>readFileSync(callsFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const writes=()=>calls().filter(call=>call.method==='POST');
  const releases=()=>writes().filter(call=>call.path.endsWith('/releases'));
  async function call(path,method='GET',body){const response=await fetch(base+'/api'+path,{method,headers:{cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};}
  async function start(){
    server=spawn(process.execPath,['--import',fixture,'server/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,RAHBAN_IGNORE_ENV:'1',LIARA_API_TOKEN:'test-account-one',LLM_API_KEY:'',RETRY_CONTROL:controlFile,RETRY_CALLS:callsFile},stdio:'pipe'});
    server.stdout.on('data',value=>output+=value);server.stderr.on('data',value=>output+=value);
    let ready=false;for(let n=0;n<60;n++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,output);
    const response=await fetch(base+'/api/session');cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;assert.equal((await call('/mode','POST',{mode:'live'})).status,200);
  }
  async function stop(){if(!server)return;const closed=new Promise(resolve=>server.once('close',resolve));server.kill();await closed;server=null;}
  async function settled(id){for(let n=0;n<100;n++){const job=(await call('/state')).body.jobs.find(job=>job.id===id);if(job&&job.status!=='running')return job;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail(output);}
  async function execute(proposal){assert.equal(proposal.status,200,JSON.stringify(proposal.body));const submitted=await call('/approvals/'+proposal.body.id+'/execute','POST',{confirmation:proposal.body.target});assert.equal(submitted.status,202,JSON.stringify(submitted.body));return settled(submitted.body.id);}
  try{
    await start();assert.deepEqual((await call('/sync','POST',{})).body,{count:0});
    const source=(await call('/sources/sample','POST',{})).body,settings={port:8080,healthPath:'/healthz',healthTimeoutMs:7000,buildCache:false};
    const input={type:'create-app',target:'name-taken',sourceId:source.id,platform:source.platform,planID:'small',bundlePlanID:'basic',settings};
    configure({networks:[]});const noNetwork=await call('/proposals','POST',input);assert.equal(noNetwork.status,409);assert.equal(noNetwork.body.code,'NETWORK_REQUIRED');assert.match(noNetwork.body.error,/Check Settings and refresh networks/);assert.equal(writes().length,0);
    configure({networkError:404});const legacy=await call('/plans');assert.equal(legacy.status,200);assert.equal(legacy.body.networks,null);assert.match(legacy.body.networkWarning,/legacy/);
    configure({networkError:0,networks:[{_id:'network-test',name:'Default'}]});
    const proposal=await call('/proposals','POST',input);assert.equal(proposal.body.cost.monthlyEstimate,1840);assert.equal(proposal.body.cost.monthlyBase,1440);assert.equal(proposal.body.cost.bundleMonthly,400);assert.equal(proposal.body.payload.network,'network-test');
    const failedCreate=await execute(proposal);assert.equal(failedCreate.status,'failed');assert.equal(failedCreate.failure.status,409);
    assert.equal(failedCreate.failure.stage,'App creation');assert.match(failedCreate.failure.nextStep,/different app name/);assert.match(failedCreate.failure.providerMessage,/Name is already taken/);assert.ok(!JSON.stringify(failedCreate).includes('test-account-one'));assert.ok(!JSON.stringify(failedCreate).includes('do-not-show'));
    assert.ok(failedCreate.steps.some(step=>step.title==='App creation'&&step.status==='failed'));assert.ok(!failedCreate.steps.some(step=>step.title==='Liara confirmed service creation'));
    const before=writes().length,draft=await call('/jobs/'+failedCreate.id+'/retry');assert.equal(draft.status,200);assert.equal(draft.body.source.id,source.id);assert.deepEqual(draft.body.settings,settings);assert.equal(draft.body.create.name,'name-taken');assert.equal(writes().length,before,'Draft reads must not mutate Liara');
    assert.equal((await call('/approvals/'+proposal.body.id+'/execute','POST',{confirmation:'name-taken'})).status,400,'Old approval cannot be replayed');
    const fresh=await call('/proposals','POST',{...input,target:'retry-ok'});assert.notEqual(fresh.body.id,proposal.body.id);assert.equal(writes().length,before);assert.equal((await execute(fresh)).status,'succeeded');
    const createWrite=writes().find(call=>call.body?.name==='retry-ok');assert.equal(createWrite.body.network,'network-test');assert.ok(!('sourceId'in createWrite.body));assert.ok(!('settings'in createWrite.body));
    const deployInput={type:'deploy',target:'retry-ok',sourceId:source.id,settings};
    const invalidated=await call('/proposals','POST',deployInput);configure({diskAttached:true});const invalidProject=await execute(invalidated);assert.equal(invalidProject.status,'failed');assert.equal(invalidProject.failure.stage,'Project validation');assert.match(invalidProject.message,/persistent disks/);assert.ok(!invalidProject.steps.some(step=>step.title==='Approved source checksum verified'));assert.equal(releases().length,0);
    configure({diskAttached:false,uploadError:true});const failedUpload=await execute(await call('/proposals','POST',deployInput));assert.equal(failedUpload.status,'failed');assert.equal(failedUpload.failure.stage,'Source upload');assert.equal(failedUpload.failure.status,400);assert.match(failedUpload.failure.providerMessage,/Archive format/);assert.ok(!failedUpload.steps.some(step=>step.title==='Source uploaded to Liara'));assert.equal(releases().length,0);configure({uploadError:false});
    configure({delayUpload:true});const deploy=await call('/proposals','POST',deployInput),submitted=await call('/approvals/'+deploy.body.id+'/execute','POST',{confirmation:'retry-ok'});
    const running=await call('/jobs/'+submitted.body.id+'/retry');assert.equal(running.status,409);assert.equal(running.body.code,'RETRY_REQUIRES_VERIFICATION');
    const failedDeploy=await settled(submitted.body.id);assert.equal(failedDeploy.status,'failed');assert.equal(failedDeploy.releaseFailed,true);
    assert.equal(failedDeploy.failure.stage,'Release build');assert.match(failedDeploy.failure.nextStep,/build logs/);assert.match(failedDeploy.message,/build output is unavailable/);assert.ok(!failedDeploy.steps.some(step=>step.title==='Liara release is READY'));
    const failedDraft=await call('/jobs/'+failedDeploy.id+'/retry');assert.equal(failedDraft.status,200);assert.equal(failedDraft.body.source.id,source.id);assert.deepEqual(failedDraft.body.settings,settings);assert.equal(releases().length,1);
    configure({release:'READ_UNCERTAIN',delayUpload:false});const uncertain=await execute(await call('/proposals','POST',deployInput));assert.equal(uncertain.status,'needs_attention');
    assert.equal((await call('/jobs/'+uncertain.id+'/retry')).status,409);assert.equal(releases().length,2,'Uncertain draft must not submit another release');
    configure({release:'UNHEALTHY'});const verifiedFailure=await call('/jobs/'+uncertain.id+'/verify','POST',{});assert.equal(verifiedFailure.status,200);assert.equal(verifiedFailure.body.status,'failed');assert.equal(verifiedFailure.body.failure.stage,'Release health');assert.equal(verifiedFailure.body.failure.code,'RELEASE_UNHEALTHY');assert.match(verifiedFailure.body.failure.nextStep,/runtime logs/);assert.equal((await call('/jobs/'+uncertain.id+'/retry')).status,200);assert.equal(releases().length,2);
    configure({release:'READY'});const success=await execute(await call('/proposals','POST',deployInput));assert.equal(success.status,'succeeded');assert.equal((await call('/jobs/'+success.id+'/retry')).status,200);
    configure({healthCode:503});const unhealthy=await execute(await call('/proposals','POST',deployInput));assert.equal(unhealthy.status,'needs_attention');assert.equal(unhealthy.failure.stage,'HTTP health verification');assert.equal(unhealthy.failure.status,503);assert.match(unhealthy.message,/HTTP 503 at \/healthz/);assert.match(unhealthy.failure.nextStep,/verify this operation again/);assert.ok(!unhealthy.steps.some(step=>step.title==='Three HTTP health checks'&&step.status==='done'));
    configure({healthCode:302});const redirected=await call('/jobs/'+unhealthy.id+'/verify','POST',{});assert.equal(redirected.status,200);assert.equal(redirected.body.status,'needs_attention');assert.equal(redirected.body.failure.status,302);assert.match(redirected.body.message,/Redirects are not followed/);
    configure({healthCode:200});const recovered=await call('/jobs/'+unhealthy.id+'/verify','POST',{});assert.equal(recovered.status,200);assert.equal(recovered.body.status,'succeeded');assert.ok(!recovered.body.failure,'Successful verification clears prior failure details');assert.equal(releases().length,4,'Health verification must not replay deployment');
    await stop();await start();assert.equal((await call('/jobs/'+success.id+'/retry')).status,200,'Stable account scope survives restart');assert.equal(releases().length,4);
    configure({release:'WRITE_UNCERTAIN'});const missingId=await execute(await call('/proposals','POST',deployInput));assert.equal(missingId.status,'needs_attention');assert.equal(missingId.failure.stage,'Release creation');assert.equal((await call('/jobs/'+missingId.id+'/retry')).status,409);assert.equal(releases().length,5);
    await call('/settings','POST',{token:'test-account-two'});const wrongAccount=await call('/jobs/'+success.id+'/retry');assert.equal(wrongAccount.status,409);assert.equal(wrongAccount.body.code,'RETRY_CONTEXT_CHANGED');
    const reads=calls().length;assert.equal((await call('/jobs/'+missingId.id+'/verify','POST',{})).status,409);assert.equal(calls().length,reads,'Cross-account verification must not query Liara');assert.equal(releases().length,5);
  }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
