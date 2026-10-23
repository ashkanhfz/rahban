import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForHealthy} from '../server/health.js';
test('routing warm-up may return 503 after READY; require three consecutive healthy responses',async()=>{
  const codes=[503,502,200,503,200,200,200];let called=0;
  const result=await waitForHealthy(async()=>({code:codes[called],ok:codes[called++]===200}),{sleep:async()=>{}});
  assert.equal(result.healthy,true);assert.equal(called,7);
});
test('verification remains unsuccessful if consecutive health never stabilizes',async()=>{
  let called=0;const result=await waitForHealthy(async()=>({ok:++called%2}),{attempts:8,sleep:async()=>{}});
  assert.equal(result.healthy,false);assert.equal(result.results.length,8);
});
