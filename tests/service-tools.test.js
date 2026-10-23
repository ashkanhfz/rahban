import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.js';
import {installServiceTools} from '../server/service-tools.js';
import {redact} from '../server/agent.js';

function fixture(t,overrides={}){
  const dir=mkdtempSync(join(tmpdir(),'rahban-service-tools-')),store=openStore(dir),routes=new Map();
  const context={scope:'account-a',mode:'live',connected:true},calls=[];
  const liara={details:async()=>({status:'RUNNING',type:'docker'}),logs:async()=>[],metricsSummary:async()=>({cpuUsage:[],memoryUsage:[]}),request:async()=>({domains:[]}),...overrides.liara};
  const app=Object.fromEntries(['get','post'].map(method=>[method,(path,handler)=>routes.set(method+' '+path,handler)]));
  const tools=installServiceTools(app,{store,api:fn=>fn,liara,getMode:()=>context.mode,getScope:()=>context.scope,connected:()=>context.connected,
    investigate:overrides.investigate||(async(...args)=>{calls.push(args);return {id:'incident-one',probe:{ok:1}};}),
    safe:value=>redact(value,['sensitive-test-value']),runtime:{snapshot:()=>({signature:'rahban:test',bootId:'boot-one'})}});
  store.put('service',{id:'app-one',mode:'live',accountScope:'account-a'});
  t.after(()=>{tools.stop();store.db.close();rmSync(dir,{recursive:true,force:true});});
  const route=async(method,path,params={id:'app-one'},body={})=>{let output;await routes.get(method+' '+path)({params,body},{json:value=>{output=value;}});return output;};
  const monitor=(id='monitor-one',extra={})=>store.put('monitor',{id,target:'app-one',accountScope:'account-a',enabled:true,intervalMinutes:5,nextRun:Date.now()-1000,...extra});
  return {store,context,liara,tools,route,calls,monitor};
}
const overview='/api/services/:id/overview',monitorPath='/api/services/:id/monitor',domainPath='/api/services/:id/domains',domainCheck=domainPath+'/:domainId/check';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('overview returns partial evidence, masks logs and refuses stale account rows',async t=>{
  const f=fixture(t,{liara:{logs:async()=>[{at:123,line:'sensitive-test-value'}],metricsSummary:async()=>{throw Object.assign(new Error('sensitive-test-value'),{status:403});}}});
  const result=await f.route('get',overview);
  assert.equal(result.service.state,'RUNNING');assert.equal(result.logs[0].line,'[REDACTED]');assert.equal(result.metrics.cpu.status,'unavailable');assert.equal(result.monitor.enabled,false);
  f.context.scope='account-b';await assert.rejects(f.route('get',overview),/Refresh the apps/);
  f.store.put('service',{id:'app-one',mode:'live'});await assert.rejects(f.route('get',overview),/Refresh the apps/);
});

test('overview and in-flight checks reject a changed or disconnected connection',async t=>{
  const f=fixture(t);f.liara.details=async()=>{f.context.connected=false;return {status:'RUNNING'};};
  await assert.rejects(f.route('get',overview),error=>error.status===409);
  const gate=deferred();const other=fixture(t,{investigate:async()=>gate.promise});
  const pending=other.tools.check('app-one');other.context.scope='account-b';gate.resolve({id:'incident-old',probe:{ok:1},accountScope:'account-a'});
  await assert.rejects(pending,error=>error.status===409);
  assert.equal(other.store.list('job')[0].status,'failed');assert.equal(other.store.list('job')[0].accountScope,'account-a');
});

test('manual checks are labeled accurately and concurrent or scheduled duplicates do not start',async t=>{
  const gate=deferred(),calls=[];const f=fixture(t,{investigate:async(...args)=>{calls.push(args);return gate.promise;}});
  f.monitor();const pending=f.tools.check('app-one');
  await assert.rejects(f.tools.check('app-one'),error=>error.status===409);
  await f.tools.tick();assert.equal(calls.length,1);assert.equal(f.store.get('monitor','monitor-one').lastRun,undefined);
  assert.deepEqual(calls[0],['app-one','Manual health check',false]);
  gate.resolve({id:'incident-one',probe:{ok:1}});const result=await pending;
  assert.equal(result.job.status,'succeeded');assert.equal(result.job.scheduled,false);
});

test('scheduler serializes ticks, respects disabling during a run and does not repeat before due',async t=>{
  const gate=deferred(),calls=[];const f=fixture(t,{investigate:async(...args)=>{calls.push(args);return gate.promise;}});
  f.monitor('first',{created:'2026-10-23T00:00:02Z'});f.monitor('second',{target:'app-two',created:'2026-10-23T00:00:01Z'});
  const pending=f.tools.tick();await f.tools.tick();assert.equal(calls.length,1);
  for(const id of ['first','second'])f.store.put('monitor',{...f.store.get('monitor',id),enabled:false,nextRun:null});
  gate.resolve({id:'incident-one',probe:{ok:0}});await pending;await f.tools.tick();
  assert.equal(calls.length,1);assert.equal(calls[0][1],'Scheduled health check');assert.equal(f.store.list('job')[0].status,'needs_attention');
  assert.equal(f.store.get('monitor','first').enabled,false);assert.equal(f.store.get('monitor','first').nextRun,null);assert.equal(f.store.get('monitor','second').lastRun,undefined);
  f.monitor('future',{nextRun:Date.now()+60000});await f.tools.tick();assert.equal(calls.length,1);
});

test('scheduler skips inactive connections, other accounts, disabled or malformed monitors',async t=>{
  const f=fixture(t);f.monitor('disabled',{enabled:false});f.monitor('other-account',{accountScope:'account-b'});f.monitor('invalid',{intervalMinutes:0});f.monitor('unscheduled',{nextRun:null});
  await f.tools.tick();assert.equal(f.calls.length,0);
  f.monitor();f.context.connected=false;await f.tools.tick();f.context.connected=true;f.context.mode='demo';await f.tools.tick();assert.equal(f.calls.length,0);
  f.context.mode='live';await f.tools.tick();await f.tools.tick();assert.equal(f.calls.length,1);
  f.monitor();f.tools.stop();await f.tools.tick();assert.equal(f.calls.length,1);
});

test('monitor configuration is validated and scoped to the active account',async t=>{
  const f=fixture(t);
  await assert.rejects(f.route('post',monitorPath,undefined,{enabled:true,intervalMinutes:2}));
  const enabled=await f.route('post',monitorPath,undefined,{enabled:true,intervalMinutes:1});assert.equal(enabled.accountScope,'account-a');assert.ok(enabled.nextRun>Date.now());
  const disabled=await f.route('post',monitorPath,undefined,{enabled:false,intervalMinutes:5});assert.equal(disabled.id,enabled.id);assert.equal(disabled.nextRun,null);
  f.context.scope='account-b';f.store.put('service',{id:'app-one',mode:'live',accountScope:'account-b'});
  assert.equal((await f.route('get',monitorPath)).enabled,false);const newMonitor=await f.route('post',monitorPath,undefined,{enabled:true});assert.notEqual(newMonitor.id,enabled.id);assert.equal(f.store.get('monitor',enabled.id).accountScope,'account-a');
});

test('domain verification requires app ownership and checks scope between reads',async t=>{
  const f=fixture(t),calls=[];
  const domain={_id:'domain-one',name:'example.test',project:{project_id:'app-one'},status:'pending',certificatesStatus:'pending',CNameRecord:'app-one.liara.run',verificationCode:'sensitive-test-value'};
  f.liara.request=async path=>{calls.push(path);return path.includes('/check')?{domain}:{domains:[domain]};};
  await assert.rejects(f.route('post',domainCheck,{id:'app-one',domainId:'not-owned'}),/does not belong/);assert.equal(calls.length,1);
  const result=await f.route('post',domainCheck,{id:'app-one',domainId:'domain-one'});assert.equal(result.id,'domain-one');assert.ok(!('verificationCode'in result));assert.equal(calls[2],'/v1/domains/domain-one/check');
  calls.length=0;f.liara.request=async path=>{calls.push(path);f.context.scope='account-b';return {domains:[domain]};};
  await assert.rejects(f.route('post',domainCheck,{id:'app-one',domainId:'domain-one'}),error=>error.status===409);assert.equal(calls.length,1);
});

test('domain lists filter cross-app rows and reject malformed or mismatched verification results',async t=>{
  const f=fixture(t);const domain={_id:'one',name:'example.test',project:{project_id:'app-one'}};
  f.liara.request=async()=>({domains:[domain,{_id:'other',name:'other.test',project:{project_id:'app-two'}},null]});
  assert.deepEqual((await f.route('get',domainPath)).domains.map(row=>row.id),['one']);
  await assert.rejects(f.route('post',domainCheck,{id:'app-one',domainId:'other'}),/does not belong/);
  f.liara.request=async path=>path.includes('/check')?{domain:{...domain,_id:'different'}}:{domains:[domain]};
  await assert.rejects(f.route('post',domainCheck,{id:'app-one',domainId:'one'}),/different domain/);
  f.liara.request=async()=>({});await assert.rejects(f.route('get',domainPath),/unexpected domain list/);
});
