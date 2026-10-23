import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.js';
import {createApproval} from '../server/policy.js';
import {installManagement} from '../server/management.js';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rahban-management-')),store=openStore(dir),routes=new Map();
  const state={mode:'live',scope:'account-a',connected:true};
  const calls=[];
  const adapter={details:async id=>{calls.push(id);return {type:'docker',envs:[{key:'TOKEN',value:'private-env-value'},{key:'APP_PORT',value:'8080'},{name:'TOKEN',value:'another-secret'}],disks:[{id:'disk-private'}],apiToken:'private-api-token'};}};
  state.adapter=adapter;
  const app={get:(path,fn)=>routes.set('GET '+path,fn),delete:(path,fn)=>routes.set('DELETE '+path,fn)};
  store.put('service',{id:'test-app',name:'Test app',mode:'live',accountScope:state.scope,platform:'node'});
  installManagement(app,{store,api:fn=>fn,getMode:()=>state.mode,getScope:()=>state.scope,connected:()=>state.connected,getAdapter:()=>state.adapter,safe:value=>String(value).replaceAll('private-api-token','[REDACTED]')});
  async function request(method,path,id){let result;await routes.get(method+' '+path)({params:{id}},{json:value=>{result=value;}});return result;}
  const job=(overrides={})=>store.put('job',{id:'finished-job',type:'deploy',mode:'live',accountScope:'account-a',target:'test-app',status:'succeeded',releaseId:'release-one',releaseRequested:true,...overrides});
  return {store,state,adapter,calls,job,remove:id=>request('DELETE','/api/jobs/:id',id),configuration:()=>request('GET','/api/services/:id/configuration','test-app'),close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('history removal hides completed jobs while preserving approval and scheduler evidence',async()=>{
  const f=fixture();try{
    const approval=createApproval(f.store,{type:'deploy',target:'test-app',payload:{sourceId:'source-one',settings:{port:8080}}},'context-a');
    const original=f.job({approvalId:approval.id,commit:'a'.repeat(40),steps:[{title:'Release ready',status:'done'}]});
    f.store.put('continuous',{id:'schedule',target:'test-app',lastJobId:original.id});
    const beforeApproval=f.store.db.prepare('SELECT * FROM approvals WHERE id=?').get(approval.id);
    assert.deepEqual(await f.remove(original.id),{ok:true});
    assert.deepEqual(f.store.get('job',original.id),{...original,hidden:true});
    assert.deepEqual(f.store.db.prepare('SELECT * FROM approvals WHERE id=?').get(approval.id),beforeApproval);
    assert.equal(f.store.get('continuous','schedule').lastJobId,original.id);
    const event=JSON.parse(f.store.db.prepare('SELECT body FROM audit ORDER BY seq DESC LIMIT 1').get().body);
    assert.equal(event.event,'history.removed');assert.equal(event.detail.id,original.id);
    const count=f.store.db.prepare('SELECT count(*) AS count FROM audit').get().count;
    await f.remove(original.id);assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM audit').get().count,count,'Repeated removal is idempotent');
    assert.equal(f.calls.length,0,'History removal must not contact Liara');
  }finally{f.close();}
});

test('running and uncertain jobs cannot be hidden, including a legacy failed ambiguous release',async()=>{
  const f=fixture();try{
    for(const status of ['running','needs_attention','interrupted','queued']){
      const original=f.job({status});await assert.rejects(f.remove(original.id),error=>error.status===409&&error.code==='HISTORY_REQUIRES_VERIFICATION');assert.deepEqual(f.store.get('job',original.id),original);
    }
    const failed=f.job({status:'failed'});await assert.rejects(f.remove(failed.id),error=>error.code==='HISTORY_REQUIRES_VERIFICATION');
    f.job({status:'failed',releaseFailed:true});assert.deepEqual(await f.remove(failed.id),{ok:true});
    assert.equal(f.calls.length,0);
  }finally{f.close();}
});

test('only completed supported job types in the current account and environment can be hidden',async()=>{
  const f=fixture();try{
    for(const type of ['deploy','create-app','check','restart','update-env','delete-app','start-app','stop-app']){
      f.job({type,status:'failed',releaseId:undefined,releaseRequested:undefined});assert.deepEqual(await f.remove('finished-job'),{ok:true});
    }
    f.job({type:'audit'});await assert.rejects(f.remove('finished-job'),error=>error.code==='HISTORY_REMOVAL_UNSUPPORTED');
    for(const override of [{accountScope:'account-b'},{accountScope:undefined},{mode:'demo'}]){
      const original=f.job(override);await assert.rejects(f.remove(original.id),error=>error.status===404);assert.deepEqual(f.store.get('job',original.id),JSON.parse(JSON.stringify(original)));
    }
    await assert.rejects(f.remove('missing'),error=>error.status===404);
    f.state.mode='demo';f.job({mode:'demo',accountScope:undefined});assert.deepEqual(await f.remove('finished-job'),{ok:true});
  }finally{f.close();}
});

test('configuration returns only sorted variable names and a minimal service view',async()=>{
  const f=fixture();try{
    const result=await f.configuration();assert.deepEqual(result,{service:{id:'test-app',name:'Test app'},platform:'docker',envKeys:['APP_PORT','TOKEN'],hasDisks:true});
    const serialized=JSON.stringify(result);for(const secret of ['private-env-value','another-secret','private-api-token','disk-private'])assert.ok(!serialized.includes(secret));
    assert.deepEqual(f.calls,['test-app']);assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM audit').get().count,0);
    assert.ok(!JSON.stringify(f.store.list('service')).includes('private-env-value'));
    f.adapter.details=async()=>({envs:[],disks:[]});assert.deepEqual(await f.configuration(),{service:{id:'test-app',name:'Test app'},platform:'node',envKeys:[],hasDisks:false});
  }finally{f.close();}
});

test('configuration uses the captured adapter and suppresses results after connection or service changes',async()=>{
  for(const change of [f=>{f.state.scope='account-b';},f=>{f.state.mode='demo';},f=>{f.state.connected=false;},f=>{f.store.put('service',{id:'test-app',mode:'live',accountScope:'account-b'});}]){
    const f=fixture();try{
      let finish;f.adapter.details=()=>new Promise(resolve=>{finish=resolve;});const pending=f.configuration();
      f.state.adapter={details:async()=>{throw new Error('Replacement adapter must not be used');}};change(f);finish({envs:[{key:'TOKEN',value:'private-env-value'}],disks:[]});
      await assert.rejects(pending,error=>error.status===409&&error.code==='CONFIGURATION_CONTEXT_CHANGED');
    }finally{f.close();}
  }
});

test('environment names remain available when Liara omits disk metadata without assuming no storage',async()=>{
  const f=fixture();try{
    for(const disks of [undefined,null,{unexpected:'private-disk-details'}]){
      f.adapter.details=async()=>({type:'node',envs:[{key:'TOKEN',value:'private-env-value'},{key:'APP_PORT',value:'3000'}],...(disks===undefined?{}:{disks})});
      const result=await f.configuration();
      assert.deepEqual(result.envKeys,['APP_PORT','TOKEN']);assert.equal(result.hasDisks,null);
      assert.ok(!JSON.stringify(result).includes('private-'));
    }
  }finally{f.close();}
});

test('configuration rejects missing connections, cross-account services and incomplete provider data without exposing values',async()=>{
  const f=fixture();try{
    f.state.connected=false;await assert.rejects(f.configuration(),error=>error.code==='LIARA_CONNECTION_REQUIRED');f.state.connected=true;
    f.state.scope='account-b';await assert.rejects(f.configuration(),error=>error.status===404);f.state.scope='account-a';assert.equal(f.calls.length,0);
    for(const details of [null,{}, {envs:[{value:'private-env-value'}],disks:[]},{envs:null,disks:[]}]){
      f.adapter.details=async()=>details;await assert.rejects(f.configuration(),error=>error.code==='LIARA_INVALID_RESPONSE'&&!error.message.includes('private-env-value'));
    }
    f.adapter.details=async()=>{throw Object.assign(new Error('private-env-value private-api-token'),{status:403});};
    await assert.rejects(f.configuration(),error=>error.status===403&&error.code==='CONFIGURATION_UNAVAILABLE'&&!error.message.includes('private-'));
  }finally{f.close();}
});
