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
test('summary metrics use the official read-only endpoint and preserve API values',async()=>{
  const expected={cpuUsage:[{applet:'one',value:[123,'0.5']}],memoryUsage:[]};
  const client=new Liara(()=>({token:'x',team:'team-one'}),async(url,init)=>{assert.equal(url.pathname,'/v1/projects/test-app/metrics/summary');assert.equal(url.searchParams.get('teamID'),'team-one');assert.equal(init.method,'GET');return Response.json(expected);});
  assert.deepEqual(await client.metricsSummary('test-app'),expected);
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
test('release creation retains instance, job and pinned commit attribution',async()=>{
  const calls=[],events=[];
  const attribution=`rahban:instance-123 job:job-456 commit:${'a'.repeat(40)}`;
  const client=new Liara(()=>({token:'x'}),async(url,init)=>{calls.push({path:url.pathname,init});events.push(url.pathname);return Response.json(calls.length===1?{sourceID:'uploaded-source'}:{releaseID:'attributed-release'});});
  const result=await client.deploy('app',Buffer.from('archive'),'docker',3000,title=>events.push(title),{attribution});
  assert.equal(result.releaseID,'attributed-release');
  assert.equal(JSON.parse(calls[1].init.body).message,attribution);
  assert.deepEqual(events,['/v2/projects/app/sources','Source uploaded to Liara','/v2/projects/app/releases']);
});
test('creation conflict is actionable, sanitized and never automatically retried',async()=>{
  let calls=0;
  const client=new Liara(()=>({token:'private-token'}),async()=>{calls++;return Response.json({message:'private-token and internal-secret'},{status:409});});
  await assert.rejects(client.create({name:'test1'}),error=>error.status===409&&error.code==='LIARA_HTTP_409'&&error.message.includes('Choose a different name')&&!error.message.includes('private-token')&&!error.message.includes('internal-secret'));
  assert.equal(calls,1);
});
test('GET retries one transient failure but never repeats an unauthorized request',async()=>{
  let calls=0;
  const client=new Liara(()=>({token:'x'}),async()=>++calls===1?Response.json({},{status:503}):Response.json({projects:[]}));
  assert.deepEqual(await client.apps(),[]);assert.equal(calls,2);
  calls=0;
  const denied=new Liara(()=>({token:'x'}),async()=>{calls++;return Response.json({},{status:401});});
  await assert.rejects(denied.apps(),error=>error.status===401&&error.message.includes('Reconnect'));
  assert.equal(calls,1);
});
test('transport retries are bounded and writes report uncertainty without replay',async()=>{
  let reads=0,writes=0;
  const read=new Liara(()=>({token:'secret'}),async()=>{reads++;throw new Error('secret transport details');});
  await assert.rejects(read.apps(),error=>error.code==='LIARA_NETWORK_ERROR'&&!error.message.includes('secret'));
  assert.equal(reads,2);
  const write=new Liara(()=>({token:'secret'}),async()=>{writes++;throw new Error('secret transport details');});
  await assert.rejects(write.restart('app'),error=>error.message.includes('may already have been applied')&&!error.message.includes('secret'));
  assert.equal(writes,1);
  writes=0;
  const unavailable=new Liara(()=>({token:'secret'}),async()=>{writes++;return Response.json({},{status:503});});
  await assert.rejects(unavailable.create({name:'app'}),error=>error.status===503&&error.message.includes('Check the Liara console'));
  assert.equal(writes,1);
});
test('validation messages redact credentials and list APIs reject malformed responses',async()=>{
  const invalid=new Liara(()=>({token:'private-token'}),async()=>Response.json({message:['network is required','token=private-token']},{status:400}));
  await assert.rejects(invalid.create({name:'app'}),error=>error.message.includes('network is required')&&!error.message.includes('private-token'));
  const malformed=new Liara(()=>({token:'x'}),async()=>Response.json({}));
  await assert.rejects(malformed.apps(),error=>error.code==='LIARA_INVALID_RESPONSE');
  await assert.rejects(malformed.networks(),error=>error.code==='LIARA_INVALID_RESPONSE');
  const client=new Liara(()=>({token:'x',team:'team-one'}),async(url)=>{assert.equal(url.pathname,'/v1/networks');assert.equal(url.searchParams.get('teamID'),'team-one');return Response.json({networks:[{_id:'network-one',name:'default'}]});});
  assert.equal((await client.networks())[0]._id,'network-one');
});
test('delete supports empty 204 responses and uses the official account-scoped endpoint once',async()=>{
  let calls=0;
  const client=new Liara(()=>({token:'fake-private-token',team:'team-one'}),async(url,init)=>{calls++;assert.equal(url.pathname,'/v1/projects/test-app');assert.equal(url.searchParams.get('teamID'),'team-one');assert.equal(init.method,'DELETE');assert.equal(init.body,undefined);return new Response(null,{status:204});});
  assert.deepEqual(await client.delete('test-app'),{});assert.equal(calls,1);
});
test('delete conflicts and uncertain errors are actionable without automatic replay',async()=>{
  for(const status of [409,404,503]){
    let calls=0;const client=new Liara(()=>({token:'x'}),async()=>{calls++;return Response.json({message:'private-upstream-details'},{status});});
    await assert.rejects(client.delete('test-app'),error=>error.status===status&&!error.message.includes('private-upstream-details')&&(status===409?error.message.includes('Another operation'):status===404?error.message.includes('already deleted'):error.message.includes('could not confirm the service deletion')));
    assert.equal(calls,1);
  }
});
test('environment reads retain string values but reject missing or malformed lists',async()=>{
  const client=new Liara(()=>({token:'x'}),async(url,init)=>{assert.equal(url.pathname,'/v1/projects/test-app');assert.equal(init.method,'GET');return Response.json({project:{envs:[{key:'VALUE',value:'fake-env-value',encrypted:true,_id:'internal-id'}]}});});
  assert.deepEqual(await client.envs('test-app'),[{key:'VALUE',value:'fake-env-value'}]);
  for(const project of [{},{envs:null},{envs:[{key:'VALUE',value:null}]}]){
    const malformed=new Liara(()=>({token:'x'}),async()=>Response.json({project}));await assert.rejects(malformed.envs('test-app'),error=>error.code==='LIARA_INVALID_RESPONSE');
  }
  const empty=new Liara(()=>({token:'x'}),async()=>Response.json({project:{envs:[]}}));assert.deepEqual(await empty.envs('test-app'),[]);
});
test('environment update submits exactly the complete approved list without fetching or restarting',async()=>{
  const calls=[];const client=new Liara(()=>({token:'x',team:'team-one'}),async(url,init)=>{calls.push({url,init});return Response.json({message:'updated'});});
  const variables=[{key:'RETAINED',value:'same',_id:'internal-id'},{key:'EMPTY',value:''},{key:'MULTILINE',value:'first\nsecond'}];
  await client.updateEnvs('test-app',variables);
  assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/v1/projects/update-envs');assert.equal(calls[0].url.searchParams.get('teamID'),'team-one');assert.equal(calls[0].init.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body),{project:'test-app',variables:variables.map(({key,value})=>({key,value}))});
  await client.updateEnvs('test-app',[]);assert.deepEqual(JSON.parse(calls[1].init.body),{project:'test-app',variables:[]});
});
test('invalid environment lists never write, and rejected updates never reflect environment values',async()=>{
  let calls=0;const client=new Liara(()=>({token:'x'}),async()=>{calls++;return Response.json({message:'The supplied value fake-env-secret is invalid'},{status:400});});
  for(const values of [null,{},[{key:'A',value:1}],[{key:'A',value:'one'},{key:'A',value:'two'}],[{key:'A=B',value:'one'}]])await assert.rejects(client.updateEnvs('test-app',values),error=>error.code==='LIARA_INVALID_ENVS');
  assert.equal(calls,0);
  await assert.rejects(client.updateEnvs('test-app',[{key:'A',value:'fake-env-secret'}]),error=>error.status===400&&error.message.includes('variable names and values')&&!error.message.includes('fake-env-secret'));
  assert.equal(calls,1);
  const malformed=new Liara(()=>({token:'x'}),async()=>Response.json(null,{status:400}));await assert.rejects(malformed.updateEnvs('test-app',[]),error=>error.status===400&&error.code==='LIARA_HTTP_400');
});
test('start and stop submit the documented scale values without claiming readiness',async()=>{
  const calls=[];const client=new Liara(()=>({token:'x'}),async(url,init)=>{calls.push({url,init});return new Response(null,{status:200});});
  assert.deepEqual(await client.start('test-app'),{});assert.deepEqual(await client.stop('test-app'),{});
  assert.deepEqual(calls.map(call=>[call.url.pathname,call.init.method,JSON.parse(call.init.body)]),[['/v1/projects/test-app/actions/scale','POST',{scale:1}],['/v1/projects/test-app/actions/scale','POST',{scale:0}]]);
});
