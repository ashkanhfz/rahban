import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createEnvironmentChanges,envChanges,envDigest} from '../server/env-changes.js';

function provider(initial=[]){
  const state={variables:structuredClone(initial),reads:[],writes:[]};
  return {state,adapter:{
    async envs(target){state.reads.push(target);return structuredClone(state.variables);},
    async updateEnvs(target,variables){state.writes.push({target,variables:structuredClone(variables)});state.variables=structuredClone(variables);},
  }};
}

test('a reviewed patch preserves untouched values and submits only its approved additions, replacements and removals',async()=>{
  const {state,adapter}=provider([{key:'KEEP',value:'retained-value'},{key:'CHANGE',value:'old-value'},{key:'REMOVE',value:'removed-value'},{key:'EMPTY',value:''}]);
  const changes=createEnvironmentChanges();
  const input={updates:[{key:'CHANGE',value:'replacement-value'},{key:'ADD',value:'first\nsecond'}],remove:['REMOVE']};
  const draft=await changes.prepare(adapter,'app-one',input);
  assert.equal(state.writes.length,0);
  assert.deepEqual(Object.keys(draft).sort(),['baseDigest','desiredDigest','patchId','removedKeys','updatedKeys']);
  assert.deepEqual(draft.updatedKeys,['CHANGE','ADD']);assert.deepEqual(draft.removedKeys,['REMOVE']);
  for(const value of ['retained-value','old-value','removed-value','replacement-value','first'])assert.ok(!JSON.stringify(draft).includes(value));
  input.updates[0].value='unreviewed-value';input.remove.push('KEEP');
  let submitted=0;
  await changes.apply(adapter,'app-one',draft,()=>{assert.equal(state.writes.length,0);submitted++;});
  assert.equal(submitted,1);assert.deepEqual(state.reads,['app-one','app-one']);
  assert.deepEqual(state.writes,[{target:'app-one',variables:[{key:'KEEP',value:'retained-value'},{key:'CHANGE',value:'replacement-value'},{key:'EMPTY',value:''},{key:'ADD',value:'first\nsecond'}]}]);
});

test('environment fingerprints ignore order and provider metadata but detect changed values',()=>{
  const first=[{key:'B',value:'two',encrypted:true},{key:'A',value:'one'}];
  assert.equal(envDigest(first),envDigest([{key:'A',value:'one'},{key:'B',value:'two'}]));
  assert.notEqual(envDigest(first),envDigest([{key:'A',value:'changed'},{key:'B',value:'two'}]));
});

test('baseline drift prevents a write and consumes the private draft',async()=>{
  const {state,adapter}=provider([{key:'KEEP',value:'original'}]);const changes=createEnvironmentChanges();
  const draft=await changes.prepare(adapter,'app-one',{updates:[{key:'ADD',value:'new-value'}]});
  state.variables[0].value='changed-in-console';let submitted=0;
  await assert.rejects(changes.apply(adapter,'app-one',draft,()=>submitted++),/configuration changed/i);
  state.variables[0].value='original';
  await assert.rejects(changes.apply(adapter,'app-one',draft),/expired/i);
  assert.equal(submitted,0);assert.equal(state.writes.length,0);
});

test('tampered approval fingerprints cannot change the reviewed patch',async()=>{
  for(const field of ['baseDigest','desiredDigest']){
    const {state,adapter}=provider();const changes=createEnvironmentChanges();
    const draft=await changes.prepare(adapter,'app-one',{updates:[{key:'VALUE',value:'reviewed'}]});
    await assert.rejects(changes.apply(adapter,'app-one',{...draft,[field]:'altered'}),/configuration changed/i);
    await assert.rejects(changes.apply(adapter,'app-one',draft),/expired/i);
    assert.equal(state.writes.length,0);
  }
});

test('a draft is target-bound and two concurrent approvals perform only one provider write',async()=>{
  const {state,adapter}=provider();const changes=createEnvironmentChanges();
  const draft=await changes.prepare(adapter,'app-one',{updates:[{key:'VALUE',value:'reviewed'}]});
  await assert.rejects(changes.apply(adapter,'another-app',draft),/expired/i);
  assert.equal(state.reads.length,1);assert.equal(state.writes.length,0);
  const results=await Promise.allSettled([changes.apply(adapter,'app-one',draft),changes.apply(adapter,'app-one',draft)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(results.find(result=>result.status==='rejected').reason.message,/expired/i);
  assert.equal(state.writes.length,1);
});

test('expired drafts and drafts lost on process restart cannot write',async()=>{
  const {state,adapter}=provider();const changes=createEnvironmentChanges({ttl:1});
  const draft=await changes.prepare(adapter,'app-one',{updates:[{key:'VALUE',value:'reviewed'}]});
  await delay(10);
  await assert.rejects(changes.apply(adapter,'app-one',draft),/expired/i);
  await assert.rejects(createEnvironmentChanges().apply(adapter,'app-one',draft),/expired/i);
  assert.equal(state.reads.length,1);assert.equal(state.writes.length,0);
});

test('provider failures redact retained, replaced, removed and new values and cannot replay the write',async()=>{
  const values=['retained-private-461','replaced-private-583','removed-private-617','new-private-729'];
  const {state,adapter}=provider([{key:'KEEP',value:values[0]},{key:'CHANGE',value:values[1]},{key:'REMOVE',value:values[2]}]);
  const changes=createEnvironmentChanges();const draft=await changes.prepare(adapter,'app-one',{updates:[{key:'CHANGE',value:values[3]}],remove:['REMOVE']});
  adapter.updateEnvs=async()=>{state.writes.push('attempt');throw Object.assign(new Error(`Provider rejected ${values.join(' ')}`),{status:503,code:'LIARA_HTTP_503'});};
  await assert.rejects(changes.apply(adapter,'app-one',draft),error=>{
    assert.equal(error.status,503);assert.equal(error.code,'LIARA_HTTP_503');
    for(const value of values)assert.ok(!error.message.includes(value),`Provider error leaked ${value}`);
    return true;
  });
  await assert.rejects(changes.apply(adapter,'app-one',draft),/expired/i);
  assert.equal(state.writes.length,1);
});

test('invalid, duplicate and conflicting variable names are rejected before provider access',async()=>{
  const invalid=[{}, {updates:[{key:'A',value:'one'},{key:'A',value:'two'}]}, {remove:['A','A']}, {updates:[{key:'A',value:'one'}],remove:['A']}, {updates:[{key:'INVALID-NAME',value:'one'}]}, {updates:[{key:'A',value:123}]}];
  const {state,adapter}=provider();const changes=createEnvironmentChanges();
  for(const input of invalid){assert.equal(envChanges.safeParse(input).success,false);await assert.rejects(changes.prepare(adapter,'app-one',input));}
  assert.equal(state.reads.length,0);assert.equal(state.writes.length,0);
});

test('removing an absent variable is rejected while deliberately removing the last variable submits an empty list',async()=>{
  const {state,adapter}=provider([{key:'LAST',value:'last-private-value'}]);const changes=createEnvironmentChanges();
  await assert.rejects(changes.prepare(adapter,'app-one',{remove:['MISSING']}),/already removed/i);
  assert.equal(state.writes.length,0);
  const draft=await changes.prepare(adapter,'app-one',{remove:['LAST']});
  await changes.apply(adapter,'app-one',draft);
  assert.deepEqual(state.writes,[{target:'app-one',variables:[]}]);
});
