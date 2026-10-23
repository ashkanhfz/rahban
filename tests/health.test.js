import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForHealthy,probeHttp} from '../server/health.js';
test('shared HTTP probe bounds requests, cancels bodies and does not follow redirects',async()=>{
  let init,cancelled=false;
  const result=await probeHttp('https://app.liara.run/healthz',{timeoutMs:2000,fetcher:async(url,options)=>{
    assert.equal(url,'https://app.liara.run/healthz');init=options;
    return {status:200,body:{cancel:async()=>{cancelled=true;}}};
  }});
  assert.equal(result.ok,1);assert.equal(result.code,200);assert.equal(init.redirect,'manual');assert.ok(init.signal);assert.ok(cancelled);
  const failure=await probeHttp('https://app.liara.run',{fetcher:async()=>{throw new Error('timeout');}});
  assert.equal(failure.ok,0);assert.equal(failure.code,0);
  const redirect=await probeHttp('https://app.liara.run',{fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://broken.example'}})});
  assert.equal(redirect.ok,0);assert.equal(redirect.code,302);
});
test('routing warm-up may return 503 after READY; require three consecutive healthy responses',async()=>{
  const codes=[503,502,200,503,200,200,200];let called=0;
  const result=await waitForHealthy(async()=>({code:codes[called],ok:codes[called++]===200}),{sleep:async()=>{}});
  assert.equal(result.healthy,true);assert.equal(called,7);
});
test('verification remains unsuccessful if consecutive health never stabilizes',async()=>{
  let called=0;const result=await waitForHealthy(async()=>({ok:++called%2}),{attempts:8,sleep:async()=>{}});
  assert.equal(result.healthy,false);assert.equal(result.results.length,8);
});
