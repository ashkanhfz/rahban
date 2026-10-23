import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendPlan,planCatalog} from '../server/sizing.js';
test('recommendation avoids under-sized and unavailable plans; price is sourced from account data',()=>{
  const make=(memory,price,available=true)=>({RAM:{amount:memory},CPU:{amount:1},price,available,region:'iran'});
  const plans={projects:{tiny:make(.25,1),fit:make(.5,2),large:make(2,6),disabled:make(1,.1,false)},projectBundlePlans:{tiny:{free:{available:true,displayPrice:0}},fit:{gold:{available:true,displayPrice:400},bronze:{available:true,displayPrice:0}},large:{bronze:{available:true,displayPrice:0}},disabled:{free:{available:true,displayPrice:0}}}};
  const result=recommendPlan(plans,{minMemoryGB:.5,minCpu:.25});assert.equal(result.planID,'fit');assert.equal(result.bundlePlanID,'bronze');assert.equal(result.monthlyEstimate,1440);
  assert.equal(recommendPlan(plans,{minMemoryGB:.5,minCpu:.25},1000),null);
  assert.equal(recommendPlan(plans,{minMemoryGB:3,minCpu:1}),null);
});
test('catalog explains absent bundles and unknown prices without inventing free options',()=>{
  const make=price=>({available:true,price,RAM:{amount:.5},CPU:{amount:.5,shared:true},volume:5,region:'iran'});
  const plans={projects:{old:make(10),unknown:make(undefined),good:make(659.72)},projectBundlePlans:{unknown:{basic:{available:true,displayPrice:0}},good:{hidden:{available:false,displayPrice:0},unknown:{available:true},basic:{available:true,displayPrice:275000,maxDeploymentCountInDay:20,maxDomainsCount:2,rollback:true,zeroDowntime:false,freeSSL:true,buildTimeout:5,unverifiedField:'ignored'}}}};
  const [old,unknown,good]=planCatalog(plans);
  assert.equal(old.selectable,false);assert.match(old.unavailableReason,/no available feature bundles/);
  assert.equal(unknown.monthlyBase,null);assert.equal(unknown.selectable,false);
  assert.equal(good.selectable,true);assert.equal(good.cpuShared,true);assert.equal(good.diskGB,5);
  assert.equal(good.bundles[0].monthlyPrice,null);assert.equal(good.bundles.length,2);
  assert.deepEqual(good.bundles[1].features.map(f=>f.name),['Deployments per day','Custom domains','Rollback','Zero downtime','Free SSL']);
  const recommendation=recommendPlan(plans);
  assert.equal(recommendation.planID,'good');assert.equal(recommendation.bundlePlanID,'basic');
  assert.equal(Math.round(recommendation.monthlyEstimate),749998);assert.match(recommendation.reason,/not a capacity guarantee/);
});
test('zero-priced bundles remain valid but malformed costs and unverified capacity do not',()=>{
  const plans={projects:{fit:{available:true,price:1,RAM:{amount:.5},CPU:{amount:.5}},noSize:{available:true,price:0},bad:{available:true,price:-1}},projectBundlePlans:{fit:{free:{available:true,displayPrice:0}},noSize:{free:{available:true,displayPrice:0}},bad:{free:{available:true,displayPrice:0}}}};
  assert.equal(recommendPlan(plans).planID,'fit');
  assert.equal(planCatalog(plans).find(p=>p.planID==='bad').selectable,false);
  assert.equal(recommendPlan({projects:{fit:plans.projects.fit}}),null);
});
