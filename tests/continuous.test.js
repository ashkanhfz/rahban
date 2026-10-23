import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.js';
import {createApproval,claimApproval} from '../server/policy.js';
import {installContinuous} from '../server/continuous.js';

const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rahban-continuous-')),store=openStore(dir),routes=new Map();
  const app={get:(path,fn)=>routes.set('GET '+path,fn),post:(path,fn)=>routes.set('POST '+path,fn)};
  const state={scope:'account-a',context:'context-a',mode:'live',connected:true,time:Date.now(),latest:B,resolveHook:null,prepareHook:null};
  const counts={resolved:0,prepared:0,executed:0},settings={port:3005,healthPath:'/',healthTimeoutMs:5000,buildCache:true};
  const github={repo:'https://github.com/owner/app',branch:'master',commit:A};
  store.put('job',{id:'initial-job',type:'deploy',target:'app-test',mode:'live',accountScope:state.scope,status:'succeeded',commit:A});
  store.put('service',{id:'app-test',mode:'live',accountScope:state.scope,github,settings,lastJobId:'initial-job'});
  async function prepare(target,source,approvedSettings){
    counts.prepared++;if(state.prepareHook)await state.prepareHook();
    return createApproval(store,{type:'deploy',target,mode:'live',payload:{github:source,settings:approvedSettings}},state.context);
  }
  function execute(id,confirmation){
    const action=claimApproval(store,id,state.context,confirmation);counts.executed++;
    return store.put('job',{type:'deploy',target:action.target,mode:'live',accountScope:state.scope,status:'running',approvalId:id,commit:action.payload.github.commit});
  }
  const options={store,api:fn=>fn,getMode:()=>state.mode,getScope:()=>state.scope,getContext:()=>state.context,connected:()=>state.connected,safe:value=>String(value).replaceAll('secret-token','[REDACTED]'),prepare,execute,now:()=>state.time,intervalMs:1000000,
    resolveSource:async(repo,branch)=>{counts.resolved++;if(state.resolveHook)return state.resolveHook(repo,branch);return {repo,branch,commit:state.latest};}};
  let scheduler=installContinuous(app,options);
  async function request(method,suffix='',body){
    let result;await routes.get(method+' /api/services/:id/continuous'+suffix)({params:{id:'app-test'},body},{json:value=>{result=value;}});return result;
  }
  const saved=()=>store.list('continuous').find(row=>row.target==='app-test'&&row.accountScope==='account-a');
  function finish(job,status='succeeded'){
    store.put('job',{...job,status});
    if(status==='succeeded'){const row=store.get('service','app-test','live');store.put('service',{...row,lastJobId:job.id,github:{...row.github,commit:job.commit}});}
  }
  return {store,state,counts,settings,request,saved,execute,finish,get scheduler(){return scheduler;},restart(){scheduler.stop();scheduler=installContinuous(app,options);},close(){scheduler.stop();store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('review defaults are opt-in; prepare only a changed commit once and wait for explicit approval',async()=>{
  const f=fixture();try{
    const initial=await f.request('GET');assert.equal(initial.enabled,false);assert.equal(initial.mode,'review');assert.equal(initial.intervalMinutes,5);assert.equal(initial.eligible,true);
    await f.scheduler.tick();assert.equal(f.counts.resolved,0);
    f.state.latest=A;await f.request('POST','',{enabled:true});
    await f.request('POST','/check');assert.equal(f.counts.resolved,1);assert.equal(f.counts.prepared,0,'Unchanged source must not be downloaded or imported');
    f.state.latest=B;const pending=await f.request('POST','/check');assert.equal(pending.status,'awaiting_approval');assert.equal(pending.pendingCommit,B);assert.ok(pending.pendingApprovalId);assert.equal(f.counts.executed,0);
    await f.scheduler.tick();await f.request('POST','/check');assert.equal(f.counts.resolved,2);assert.equal(f.counts.prepared,1,'One pending approval per commit');
    const action=JSON.parse(f.store.db.prepare('SELECT body FROM approvals WHERE id=?').get(pending.pendingApprovalId).body);assert.equal(action.payload.github.branch,'master');assert.equal(action.payload.github.commit,B);assert.deepEqual(action.payload.settings,f.settings);
    const job=f.execute(pending.pendingApprovalId,'app-test');assert.equal((await f.request('POST','/check')).status,'deploying');f.finish(job);
    const completed=await f.request('POST','/check');assert.equal(completed.status,'scheduled');assert.equal(completed.pendingApprovalId,null);assert.equal(completed.latestCommit,B);
    await f.scheduler.tick();assert.equal(f.counts.resolved,2,'No catch-up polling before next interval');
    f.state.time+=300001;f.state.latest=C;await f.scheduler.tick();assert.equal(f.counts.prepared,2);assert.equal(f.counts.executed,1,'Review mode never executes itself');
  }finally{f.close();}
});

test('automatic mode requires target confirmation and stops after failed or uncertain deployment',async()=>{
  for(const failure of ['failed','needs_attention','interrupted']){
    const f=fixture();try{
      await assert.rejects(f.request('POST','',{enabled:true,mode:'automatic',confirmation:'wrong'}),error=>error.code==='CONTINUOUS_CONFIRMATION_REQUIRED');
      await f.request('POST','',{enabled:true,mode:'automatic',confirmation:'app-test',intervalMinutes:1});
      const result=await f.request('POST','/check');assert.equal(result.status,'deploying');assert.equal(f.counts.executed,1);
      await f.scheduler.tick();assert.equal(f.counts.executed,1,'Running job must not be replayed');
      const job=f.store.get('job',result.lastJobId);f.finish(job,failure);
      const stopped=await f.request('POST','/check');assert.equal(stopped.enabled,false);assert.equal(stopped.status,'paused');assert.match(stopped.lastError,/failed or needs verification/);
      f.state.time+=3600000;await f.scheduler.tick();assert.equal(f.counts.executed,1);assert.equal(f.counts.prepared,1);
      await assert.rejects(f.request('POST','/check'),error=>error.code==='CONTINUOUS_DISABLED');
    }finally{f.close();}
  }
});

test('blocks other unfinished cloud jobs while allowing read-only monitoring jobs',async()=>{
  const f=fixture();try{
    f.store.put('job',{id:'check-only',type:'check',target:'app-test',mode:'live',accountScope:'account-a',status:'needs_attention'});
    await f.request('POST','',{enabled:true,mode:'automatic',confirmation:'app-test'});
    f.store.put('job',{id:'manual-job',type:'deploy',target:'app-test',mode:'live',accountScope:'account-a',status:'interrupted'});
    for(let n=0;n<110;n++)f.store.put('job',{type:'check',target:'app-test',mode:'live',accountScope:'account-a',status:'succeeded'});
    const result=await f.request('POST','/check');assert.equal(result.status,'paused');assert.equal(f.counts.resolved,0);assert.equal(f.counts.executed,0);
    await assert.rejects(f.request('POST','',{enabled:true}),error=>error.code==='CONTINUOUS_OPERATION_PENDING');
  }finally{f.close();}
});

test('connection changes during GitHub lookup cancel work and simultaneous checks cannot overlap',async()=>{
  const f=fixture();try{
    let release;f.state.resolveHook=()=>new Promise(resolve=>{release=resolve;});
    await f.request('POST','',{enabled:true,mode:'automatic',confirmation:'app-test'});
    const running=f.request('POST','/check');await assert.rejects(f.request('POST','/check'),error=>error.code==='CONTINUOUS_BUSY');
    f.state.context='changed-context';release({repo:'https://github.com/owner/app',branch:'master',commit:B});
    const result=await running;assert.equal(result.enabled,false);assert.equal(f.counts.prepared,0);assert.equal(f.counts.executed,0);
    f.state.scope='other-account';await assert.rejects(f.request('GET'),error=>error.code==='CONTINUOUS_SERVICE_MISSING');
    await f.scheduler.tick();assert.equal(f.counts.resolved,1);
  }finally{f.close();}
});

test('disabling during source preparation rejects the draft and never restores standing authorization',async()=>{
  const f=fixture();try{
    let release,entered;const started=new Promise(resolve=>{entered=resolve;});
    f.state.prepareHook=()=>{entered();return new Promise(resolve=>{release=resolve;});};
    await f.request('POST','',{enabled:true,mode:'automatic',confirmation:'app-test'});
    const running=f.request('POST','/check');await started;await f.request('POST','',{enabled:false});release();await running;
    assert.equal(f.saved().enabled,false);assert.equal(f.saved().status,'disabled');assert.equal(f.counts.executed,0);
    assert.equal(f.store.db.prepare('SELECT status FROM approvals').get().status,'rejected');
  }finally{f.close();}
});

test('restart pauses saved schedules and does not replay missed commits or persist credentials',async()=>{
  const f=fixture();try{
    await f.request('POST','',{enabled:true,mode:'automatic',confirmation:'app-test',intervalMinutes:60});
    f.state.time+=86400000;f.restart();await f.scheduler.tick();
    const result=await f.request('GET');assert.equal(result.enabled,false);assert.equal(result.status,'paused');assert.match(result.lastError,/restarted/);assert.equal(f.counts.resolved,0);
    assert.ok(!('approvalContext'in result));assert.ok(!('accountScope'in result));
    assert.ok(!JSON.stringify(f.saved()).includes('confirmation'));assert.ok(!JSON.stringify(f.saved()).includes('token'));
    await f.request('POST','',{enabled:true,mode:'automatic',confirmation:'app-test'});assert.equal(f.saved().nextRun,f.state.time+300000);
  }finally{f.close();}
});

test('source/settings drift, rejected approvals, and provider errors pause without mutation',async()=>{
  const f=fixture();try{
    await f.request('POST','',{enabled:true});const pending=await f.request('POST','/check');
    f.store.db.prepare("UPDATE approvals SET status='rejected' WHERE id=?").run(pending.pendingApprovalId);
    assert.equal((await f.request('POST','/check')).status,'paused');assert.equal(f.counts.prepared,1);
    await f.request('POST','',{enabled:true});const row=f.store.get('service','app-test','live');f.store.put('service',{...row,settings:{...row.settings,port:9999}});
    assert.match((await f.request('POST','/check')).lastError,/settings changed/);assert.equal(f.counts.prepared,1);
    f.store.put('service',row);await f.request('POST','',{enabled:true});f.state.resolveHook=()=>{throw new Error('Provider failed with secret-token');};
    const failed=await f.request('POST','/check');assert.equal(failed.enabled,false);assert.ok(!failed.lastError.includes('secret-token'));assert.equal(f.counts.executed,0);
  }finally{f.close();}
});

test('requires a verified successful GitHub deployment and validates scheduling intervals',async()=>{
  const f=fixture();try{
    await assert.rejects(f.request('POST','',{enabled:true,intervalMinutes:2}));
    const row=f.store.get('job','initial-job');f.store.put('job',{...row,status:'needs_attention'});
    assert.equal((await f.request('GET')).eligible,false);await assert.rejects(f.request('POST','',{enabled:true}),error=>error.code==='CONTINUOUS_INELIGIBLE');
    assert.equal(f.counts.resolved,0);assert.equal(f.counts.prepared,0);
  }finally{f.close();}
});

test('a manual deployment completed during preparation cannot be overwritten by the scheduler',async()=>{
  const f=fixture();try{
    f.state.prepareHook=async()=>{f.finish(f.store.put('job',{type:'deploy',target:'app-test',mode:'live',accountScope:'account-a',status:'running',commit:C}));};
    await f.request('POST','',{enabled:true,mode:'automatic',confirmation:'app-test'});
    const result=await f.request('POST','/check');assert.equal(result.status,'paused');assert.match(result.lastError,/changed the app/);assert.equal(f.counts.executed,0);
    assert.equal(f.store.db.prepare('SELECT status FROM approvals').get().status,'rejected');
  }finally{f.close();}
});
