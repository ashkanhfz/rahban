import test from 'node:test';
import assert from 'node:assert/strict';
import {collectServiceEvidence} from '../server/observability.js';
import {diagnose} from '../server/agent.js';

test('evidence reads run concurrently and whitelist details without inventing metric units',async()=>{
  const started=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const adapter=Object.fromEntries(Object.entries({
    details:{status:'RUNNING',type:'docker',planID:'small-g2',isDeployed:true,envs:[{key:'PASSWORD',value:'private-value'}],token:'private-value'},
    logs:[{at:'123',line:'Started',metadata:{secret:'private-value'}}],
    metricsSummary:{cpuUsage:[{applet:'app-1',value:[123,'0.52']}],memoryUsage:[{applet:'app-1',value:[123,'250000000']}],disksUsage:[{secret:'private-value'}]},
  }).map(([name,result])=>[name,async target=>{assert.equal(target,'example');started.push(name);if(started.length===3)release();await gate;return result;}]));
  const evidence=await collectServiceEvidence(adapter,'example');
  assert.equal(started.length,3);
  assert.deepEqual(evidence.service,{state:'RUNNING',platform:'docker',planID:'small-g2',isDeployed:true});
  assert.deepEqual(evidence.logs,[{at:'123',line:'Started'}]);
  assert.deepEqual(evidence.metrics.cpu,{status:'available',samples:[{applet:'app-1',at:123,value:.52}],unit:null});
  assert.equal(evidence.metrics.memory.samples[0].value,250000000);
  assert.match(evidence.limitations.join(' '),/does not document/);
  assert.ok(!JSON.stringify(evidence).includes('private-value'));
});

test('failed details and metrics do not discard logs or leak upstream errors',async()=>{
  const evidence=await collectServiceEvidence({
    details:async()=>{throw new Error('private-provider-token');},
    logs:async()=>[{at:123,line:'ECONNREFUSED database'}],
    metricsSummary:async()=>{throw Object.assign(new Error('private-provider-token'),{status:403});},
  },'example');
  assert.equal(evidence.logs.length,1);assert.equal(evidence.service.state,'unknown');
  assert.equal(evidence.metrics.cpu.status,'unavailable');assert.deepEqual(evidence.metrics.memory.samples,[]);
  assert.match(evidence.metrics.cpu.reason,/HTTP 403/);assert.ok(!JSON.stringify(evidence).includes('private-provider-token'));
});

test('missing and malformed metrics stay unavailable while numeric zero remains available',async()=>{
  const evidence=await collectServiceEvidence({details:async()=>null,logs:async()=>null,metricsSummary:async()=>({cpuUsage:[{value:[123,0]},{value:[123,'']},{value:[123,null]},{value:[123,'NaN']},{value:[null,'2']}],memoryUsage:[]})},'example');
  assert.deepEqual(evidence.metrics.cpu.samples,[{applet:null,at:123,value:0}]);
  assert.equal(evidence.metrics.memory.status,'unavailable');assert.equal(evidence.metrics.memory.unit,null);
  const unsupported=await collectServiceEvidence({details:async()=>({}),logs:async()=>[]},'example');
  assert.equal(unsupported.metrics.cpu.status,'unavailable');assert.match(unsupported.limitations.join(' '),/Resource metrics are unavailable/);
});

test('diagnosis ranks direct log evidence first and does not recommend restart as a configuration fix',()=>{
  const result=diagnose([{line:'Missing DATABASE_URL\nOOMKilled\nECONNREFUSED upstream'}],{ok:false,code:500,ms:1800},{metrics:{cpu:{status:'available',unit:'percent_of_limit',samples:[{applet:'one',at:123,value:95}]}}});
  assert.equal(result[0].rank,1);assert.equal(result[0].title,'Missing or invalid configuration');
  assert.match(result[0].next,/Restarting alone will not repair/);assert.match(result[1].next,/failure can recur/);
  assert.match(result[2].next,/will not repair/);assert.equal(result[3].title,'Possible cpu pressure');
  assert.deepEqual(result.map(item=>item.rank),[1,2,3,4,5]);
});

test('large raw metrics never establish resource pressure, and old samples do not override latest samples',()=>{
  const probe={ok:true,code:200,ms:100};
  const metrics={cpu:{status:'available',unit:null,samples:[{applet:'one',at:123,value:9000}]},memory:{status:'available',unit:null,samples:[{applet:'one',at:123,value:3000000000}]}};
  assert.equal(diagnose([],probe,{metrics})[0].title,'No failure established in the current sample');
  metrics.cpu={status:'available',unit:'percent_of_limit',samples:[{applet:'one',at:122,value:99},{applet:'one',at:123,value:12}]};
  assert.equal(diagnose([],probe,{metrics})[0].title,'No failure established in the current sample');
  metrics.cpu.samples.push({applet:'two',at:123,value:97});
  assert.match(diagnose([],probe,{metrics})[0].evidence,/two: 97% of limit/);
});
