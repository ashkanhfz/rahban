import test from 'node:test';
import assert from 'node:assert/strict';
import {Liara} from '../server/liara.js';
test('Liara calls official origin with server bearer and optional team',async()=>{
  const calls=[];const client=new Liara(()=>({token:'secret',team:'team-a'}),async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({projects:[]}));});
  await client.apps();await client.restart('test-app');assert.equal(calls[0].url.origin,'https://api.liara.ir');assert.equal(calls[0].init.headers.Authorization,'Bearer secret');assert.equal(calls[0].url.searchParams.get('teamID'),'team-a');assert.equal(calls[1].init.method,'POST');assert.equal(calls[1].url.pathname,'/v1/projects/test-app/actions/restart');
});
test('log API uses seconds, not milliseconds; flattens Liara streams',async()=>{
  let start;const client=new Liara(()=>({token:'x'}),async(url)=>{start=Number(url.searchParams.get('start'));return new Response(JSON.stringify({data:[{values:[['123','line']]}]}));});const logs=await client.logs('app');assert.ok(start<100000000000);assert.equal(logs[0].line,'line');
});
test('API errors never reflect upstream secrets',async()=>{const client=new Liara(()=>({token:'x'}),async()=>new Response(JSON.stringify({message:'secret-upstream'}),{status:402}));await assert.rejects(client.apps(),e=>!e.message.includes('secret-upstream')&&e.message.includes('Top up'));});
test('upload and create-release are separate and use exact source ID',async()=>{
  const calls=[];const client=new Liara(()=>({token:'x'}),async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(calls.length===1?{sourceID:'source-1'}:{releaseID:'release-1'}));});const result=await client.deploy('app',Buffer.from('archive'),'node',3000);assert.equal(result.releaseID,'release-1');assert.equal(calls[0].init.body.get('file').type,'application/gzip');const payload=JSON.parse(calls[1].init.body);assert.equal(payload.sourceID,'source-1');assert.equal(payload.port,3000);assert.deepEqual(payload.platformConfig,{});assert.ok(!('envs'in payload));
});
test('Docker releases use root Dockerfile and honor the approved build cache setting',async()=>{
  const calls=[];const client=new Liara(()=>({token:'x'}),async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(calls.length===1?{sourceID:'docker-source'}:{releaseID:'docker-release'}));});
  await client.deploy('app',Buffer.from('archive'),'docker',8080,()=>{},{buildCache:false});
  const payload=JSON.parse(calls[1].init.body);
  assert.equal(payload.type,'docker');assert.equal(payload.port,8080);
  assert.deepEqual(payload.build,{cache:false,dockerfile:'Dockerfile'});
  assert.deepEqual(payload.platformConfig,{});assert.ok(!('envs' in payload));
});
