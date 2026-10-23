import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {collectServiceEvidence} from './observability.js';

const monitorInput=z.object({enabled:z.boolean(),intervalMinutes:z.union([z.literal(1),z.literal(5),z.literal(15),z.literal(60)]).default(5)});
const domainView=d=>({id:d._id,name:d.name,status:typeof d.status==='string'?d.status:'unknown',ssl:typeof d.certificatesStatus==='string'?d.certificatesStatus:'unknown',cname:typeof d.CNameRecord==='string'?d.CNameRecord:null});
const belongsTo=(domain,target)=>!domain?.project?.project_id||domain.project.project_id===target;
function domainList(data,target){
  if(!Array.isArray(data?.domains))throw new Error('Liara returned an unexpected domain list. Refresh before verifying a domain.');
  return data.domains.filter(domain=>typeof domain?._id==='string'&&typeof domain.name==='string'&&belongsTo(domain,target));
}

// Scheduling is local and read-only. Credentials remain in the active connection.
export function installServiceTools(app,{store,api,liara,getMode,getScope,connected,investigate,safe,runtime}){
  const busy=new Set();
  let ticking=false,stopped=false;
  const clean=value=>JSON.parse(safe(JSON.stringify(value)));
  const current=scope=>getMode()==='live'&&connected()&&getScope()===scope;
  function assertCurrent(scope){if(!current(scope))throw Object.assign(new Error('Connection changed. Refresh this app.'),{status:409});}
  function service(id){
    if(getMode()!=='live'||!connected())throw new Error('Connect to Liara first.');
    const row=store.get('service',id,'live');
    if(!row||row.accountScope!==getScope())throw new Error('Refresh the apps for this account first.');
    return row;
  }
  const monitorFor=target=>store.list('monitor').find(m=>m.target===target&&m.accountScope===getScope());
  const defaults=target=>({target,enabled:false,intervalMinutes:5,nextRun:null});
  async function check(target,scheduled=false){
    const row=service(target),scope=getScope(),key=scope+':'+target;
    if(busy.has(key))throw Object.assign(new Error('A health check is already running for this app.'),{status:409});
    busy.add(key);
    let job;
    try{
      job=store.put('job',{type:'check',target,title:'Check service health',mode:'live',accountScope:scope,status:'running',steps:[],rahban:runtime.snapshot().signature,bootId:runtime.snapshot().bootId,scheduled});
      // The investigation captures its adapter before any asynchronous work.
      const incident=await investigate(row.id,scheduled?'Scheduled health check':'Manual health check',false);
      assertCurrent(scope);
      if(incident.accountScope&&incident.accountScope!==scope)throw new Error('The investigation belongs to another connection. Refresh this app.');
      job=store.put('job',{...job,status:incident.probe?.ok?'succeeded':'needs_attention',incidentId:incident.id,steps:[{title:'HTTP, logs and resource reports checked',status:'done'}],message:incident.probe?.ok?'Check complete. Review the observations for warnings.':'Service needs attention. Review the investigation before changing anything.'});
      store.audit('monitor.checked',{target,jobId:job.id,incidentId:incident.id,scheduled});
      return clean({job,incident});
    }catch(error){
      if(job)store.put('job',{...job,status:'failed',message:current(scope)?safe(error.message):'Connection changed while this check was running. Refresh this app.'});
      assertCurrent(scope);throw error;
    }finally{busy.delete(key);}
  }
  app.get('/api/services/:id/overview',api(async(req,res)=>{
    const row=service(req.params.id),scope=getScope();
    const evidence=await collectServiceEvidence(liara,row.id);
    assertCurrent(scope);
    res.json({...clean(evidence),checkedAt:new Date().toISOString(),monitor:monitorFor(row.id)||defaults(row.id)});
  }));
  app.get('/api/services/:id/monitor',api(async(req,res)=>{const row=service(req.params.id);res.json(monitorFor(row.id)||defaults(row.id));}));
  app.post('/api/services/:id/monitor',api(async(req,res)=>{
    const row=service(req.params.id),input=monitorInput.parse(req.body),old=monitorFor(row.id);
    const monitor=store.put('monitor',{...old,id:old?.id||randomUUID(),target:row.id,accountScope:getScope(),...input,nextRun:input.enabled?Date.now()+input.intervalMinutes*60000:null});
    store.audit('monitor.updated',{target:row.id,enabled:input.enabled,intervalMinutes:input.intervalMinutes});res.json(monitor);
  }));
  app.post('/api/services/:id/check',api(async(req,res)=>res.json(await check(req.params.id))));
  app.get('/api/services/:id/domains',api(async(req,res)=>{
    const row=service(req.params.id),scope=getScope();
    const data=await liara.request('/v1/domains?project='+encodeURIComponent(row.id));
    assertCurrent(scope);
    res.json(clean({domains:domainList(data,row.id).map(domainView),guide:'https://docs.liara.ir/paas/domains/add-domain/'}));
  }));
  app.post('/api/services/:id/domains/:domainId/check',api(async(req,res)=>{
    const row=service(req.params.id),scope=getScope();
    const list=await liara.request('/v1/domains?project='+encodeURIComponent(row.id));
    assertCurrent(scope);
    if(!domainList(list,row.id).some(d=>d._id===req.params.domainId))throw new Error('This domain does not belong to the selected app.');
    const result=await liara.request('/v1/domains/'+encodeURIComponent(req.params.domainId)+'/check');
    assertCurrent(scope);
    if(result?.domain?._id!==req.params.domainId||!belongsTo(result.domain,row.id))throw new Error('Liara returned a different domain. Refresh the domain list.');
    res.json(clean(domainView(result.domain)));
  }));
  async function tick(){
    if(ticking||stopped||getMode()!=='live'||!connected())return;
    ticking=true;
    const scope=getScope();
    try{for(const snapshot of store.list('monitor')){
      if(stopped||!current(scope))break;
      const item=store.get('monitor',snapshot.id),input=monitorInput.safeParse(item);
      if(!item||item.accountScope!==scope||!input.success||!input.data.enabled||!Number.isFinite(item.nextRun)||item.nextRun>Date.now()||busy.has(scope+':'+item.target))continue;
      store.put('monitor',{...item,nextRun:Date.now()+input.data.intervalMinutes*60000,lastRun:Date.now()});
      let lastError=null;
      try{await check(item.target,true);}catch(error){lastError=current(scope)?safe(error.message):'Connection changed while this check was running.';}
      const latest=store.get('monitor',item.id);
      if(latest?.accountScope===scope&&latest.target===item.target)store.put('monitor',{...latest,lastError});
    }}finally{ticking=false;}
  }
  const timer=setInterval(()=>{void tick().catch(()=>{});},10000);
  timer.unref();
  return {stop:()=>{stopped=true;clearInterval(timer);},tick,check};
}
