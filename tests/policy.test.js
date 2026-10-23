import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.js';
import {createApproval,claimApproval} from '../server/policy.js';
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'rahban-policy-'));const store=openStore(dir);return {store,close:()=>{store.db.close();rmSync(dir,{recursive:true,force:true});}};};
test('approval is bound to account, operation and exact target, consumed only once',()=>{
  const {store,close}=fixture();try{
    const action=createApproval(store,{type:'restart',target:'app-a',payload:{target:'app-a'}},'account-a');
    assert.throws(()=>claimApproval(store,action.id,'account-b','app-a'));
    assert.throws(()=>claimApproval(store,action.id,'account-a','app-b'));
    const claimed=claimApproval(store,action.id,'account-a','app-a');assert.equal(claimed.payload.target,'app-a');
    assert.throws(()=>claimApproval(store,action.id,'account-a','app-a'));
  }finally{close();}
});
test('expired and rejected approvals cannot execute',()=>{
  const {store,close}=fixture();try{const expired=createApproval(store,{target:'app-a'},'ctx',-1);assert.throws(()=>claimApproval(store,expired.id,'ctx','app-a'));const rejected=createApproval(store,{target:'app-a'},'ctx');store.db.prepare("UPDATE approvals SET status='rejected' WHERE id=?").run(rejected.id);assert.throws(()=>claimApproval(store,rejected.id,'ctx','app-a'));}finally{close();}
});
test('audit events form a verifiable hash chain',()=>{
  const {store,close}=fixture();try{store.audit('a',{target:'x'});store.audit('b',{target:'y'});const events=store.db.prepare('SELECT * FROM audit ORDER BY seq').all();assert.equal(events[0].prev,'GENESIS');assert.equal(events[1].prev,events[0].hash);}finally{close();}
});
test('sandbox and cloud services with the same name cannot overwrite each other',()=>{const {store,close}=fixture();try{store.put('service',{id:'sandbox-store',mode:'demo',name:'local'});store.put('service',{id:'sandbox-store',mode:'live',name:'cloud'});assert.equal(store.get('service','sandbox-store','demo').name,'local');assert.equal(store.get('service','sandbox-store','live').name,'cloud');assert.equal(store.list('service').length,2);}finally{close();}});
