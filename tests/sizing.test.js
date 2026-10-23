import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendPlan} from '../server/sizing.js';
test('recommendation avoids under-sized and unavailable plans; price is sourced from account data',()=>{
  const make=(memory,price,available=true)=>({RAM:{amount:memory},CPU:{amount:1},price,available,region:'iran'});
  const plans={projects:{tiny:make(.25,1),fit:make(.5,2),large:make(2,6),disabled:make(1,.1,false)},projectBundlePlans:{tiny:{free:{available:true,displayPrice:0}},fit:{gold:{available:true,displayPrice:400},bronze:{available:true,displayPrice:0}},large:{bronze:{available:true,displayPrice:0}},disabled:{free:{available:true,displayPrice:0}}}};
  const result=recommendPlan(plans,{minMemoryGB:.5,minCpu:.25});assert.equal(result.planID,'fit');assert.equal(result.bundlePlanID,'bronze');assert.equal(result.monthlyEstimate,1440);
  assert.equal(recommendPlan(plans,{minMemoryGB:.5,minCpu:.25},1000),null);
  assert.equal(recommendPlan(plans,{minMemoryGB:3,minCpu:1}),null);
});
