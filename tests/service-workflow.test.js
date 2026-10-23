import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('connected Liara workflow keeps partial evidence, ranks faults and gates mutations',{timeout:10000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rahban-services-')),callsFile=join(dir,'calls.jsonl');
  const child=spawn(process.execPath,['--import','./tests/fixtures/service-fetch.js','server/index.js'],{
    cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'4321',HOST:'127.0.0.1',DATA_DIR:dir,RAHBAN_IGNORE_ENV:'1',LIARA_API_TOKEN:'',LIARA_TEAM_ID:'',LLM_API_KEY:'',LLM_SHARE_EVIDENCE:'false',PUBLIC_ORIGIN:'',OPERATOR_PASSWORD_HASH:'',TEST_SERVICE_CALLS:callsFile},stdio:'pipe',
  });
  const closed=new Promise(resolve=>child.once('close',resolve));let output='',cookie='',csrf='';
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  const base='http://127.0.0.1:4321',calls=()=>existsSync(callsFile)?readFileSync(callsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  async function call(path,method='GET',body){
    const response=await fetch(base+'/api'+path,{method,headers:{cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  try{
    let ready=false;for(let n=0;n<60;n++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,output);
    const session=await fetch(base+'/api/session');cookie=session.headers.get('set-cookie').split(';')[0];csrf=(await session.json()).csrf;
    assert.equal((await call('/settings','POST',{token:'workflow-test-token',team:'team-test'})).body.connected,true);
    assert.equal((await call('/mode','POST',{mode:'live'})).status,200);
    assert.equal((await call('/sync','POST',{})).body.count,1);
    const state=(await call('/state')).body;assert.equal(state.services[0].id,'service-test');assert.ok(state.services[0].accountScope);

    const overview=await call('/services/service-test/overview');assert.equal(overview.status,200);
    assert.equal(overview.body.service.state,'RUNNING');assert.equal(overview.body.metrics.cpu.status,'unavailable');assert.match(overview.body.limitations.join(' '),/HTTP 403/);
    assert.equal(overview.body.logs.length,2);assert.match(overview.body.logs[0].line,/REDACTED/);assert.equal(overview.body.monitor.enabled,false);
    assert.ok(!JSON.stringify(overview.body).includes('workflow-test-token'));assert.ok(!JSON.stringify(overview.body).includes('details-secret'));assert.ok(!JSON.stringify(overview.body).includes('metrics-provider-secret'));
    const incident=await call('/incidents','POST',{target:'service-test',message:'The website returns HTTP 500'});
    assert.equal(incident.status,200);assert.equal(incident.body.probe.code,500);assert.equal(incident.body.status,'open');assert.equal(incident.body.engine,'rules');
    assert.equal(incident.body.hypotheses[0].rank,1);assert.equal(incident.body.hypotheses[0].title,'Missing or invalid configuration');assert.match(incident.body.hypotheses[0].next,/Restarting alone will not repair/);
    assert.equal(incident.body.metrics.cpu.unit,null);assert.equal(incident.body.metrics.cpu.samples[0].value,.35);assert.equal(incident.body.metrics.memory.status,'unavailable');

    assert.equal((await call('/services/service-test/monitor','POST',{enabled:true,intervalMinutes:2})).status,400);
    const monitor=await call('/services/service-test/monitor','POST',{enabled:true,intervalMinutes:1});assert.equal(monitor.status,200);assert.equal(monitor.body.enabled,true);assert.ok(monitor.body.nextRun>Date.now());
    const check=await call('/services/service-test/check','POST',{});assert.equal(check.status,200);assert.equal(check.body.job.status,'needs_attention');assert.equal(check.body.job.scheduled,false);assert.equal(check.body.incident.message,'Manual health check');
    assert.equal((await call('/services/service-test/monitor','POST',{enabled:false,intervalMinutes:1})).body.nextRun,null);

    const domains=await call('/services/service-test/domains');assert.deepEqual(domains.body.domains.map(domain=>domain.id),['domain-owned']);
    const checksBefore=calls().filter(call=>call.path?.endsWith('/check')).length;
    assert.equal((await call('/services/service-test/domains/domain-other/check','POST',{})).status,400);assert.equal(calls().filter(call=>call.path?.endsWith('/check')).length,checksBefore);
    const verified=await call('/services/service-test/domains/domain-owned/check','POST',{});assert.equal(verified.status,200);assert.equal(verified.body.status,'verified');assert.equal(verified.body.ssl,'issued');

    const proposal=await call('/proposals','POST',{type:'restart',target:'service-test'});assert.equal(proposal.status,200);assert.equal(proposal.body.risk,'high');assert.equal(proposal.body.type,'restart');
    assert.equal((await call('/proposals','POST',{type:'restart',target:'../../outside'})).status,400);
    assert.equal((await call('/proposals','POST',{type:'delete',target:'service-test'})).status,400);
    const after=(await call('/state')).body;assert.equal(after.approvals.find(row=>row.id===proposal.body.id).status,'pending');assert.ok(after.jobs.every(job=>job.type==='check'));
    assert.ok(calls().filter(call=>call.path).every(call=>call.method==='GET'&&call.team==='team-test'));assert.ok(!calls().some(call=>call.path?.includes('/actions/restart')));

    // Persisted evidence and destinations must not cross Liara account/team boundaries.
    assert.equal((await call('/settings','POST',{team:'another-team'})).status,200);
    const beforeForeignReads=calls().length;
    assert.equal((await call('/logs/service-test')).status,400);
    assert.equal((await call('/probe/service-test','POST',{})).status,400);
    assert.equal((await call('/proposals','POST',{type:'restart',target:'service-test'})).status,400);
    const report=await fetch(base+'/api/incidents/'+incident.body.id+'/report',{headers:{cookie}});assert.equal(report.status,404);
    const foreign=(await call('/state')).body;
    for(const key of ['services','jobs','incidents','approvals','probes'])assert.equal(foreign[key].length,0,key+' must be scoped to the active connection');
    assert.ok(foreign.audit.every(row=>row.event!=='incident.investigated'));assert.equal(calls().length,beforeForeignReads,'Rejected stale destinations must not contact Liara');
  }finally{child.kill();await closed;rmSync(dir,{recursive:true,force:true});}
});
