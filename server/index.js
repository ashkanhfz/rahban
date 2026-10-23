import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import {z} from 'zod';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openStore} from './store.js';
import {createApproval,claimApproval} from './policy.js';
import {Liara} from './liara.js';
import {archive,inspect,unpackZip,sampleFiles,digest} from './source.js';
import {redact,diagnose,llmAdvice} from './agent.js';
import {recommendPlan} from './sizing.js';
import {waitForHealthy,probeHttp} from './health.js';
import {deploySettings,resolveSettings,previewDeployment} from './deployment.js';
import {installAccess} from './access.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.env.RAHBAN_IGNORE_ENV!=='1')try{process.loadEnvFile(join(root,'.env'));}catch{}
const hostingFile=join(root,'hosting.private.json');
const hosting=process.env.RAHBAN_IGNORE_ENV==='1'?{}:(existsSync(hostingFile)?JSON.parse(readFileSync(hostingFile,'utf8')):{});
const publicOrigin=process.env.PUBLIC_ORIGIN||hosting.origin||'';
const data=resolve(process.env.DATA_DIR||hosting.dataDir||join(root,'data'));mkdirSync(join(data,'sources'),{recursive:true});
const store=openStore(data);
// In-flight operations after a process crash are uncertain: never replay a cloud mutation.
store.db.prepare("UPDATE approvals SET status='interrupted' WHERE status='executing'").run();
for(const job of store.list('job').filter(j=>j.status==='running'))store.put('job',{...job,status:'interrupted',message:'Interrupted. Check Liara before retrying.'});
const config={token:process.env.LIARA_API_TOKEN||'',team:process.env.LIARA_TEAM_ID||'',llmBase:process.env.LLM_BASE_URL||'',llmKey:process.env.LLM_API_KEY||'',llmModel:process.env.LLM_MODEL||'',shareEvidence:process.env.LLM_SHARE_EVIDENCE==='true',revision:randomUUID()};
let mode='demo',demoFault=null;const demoLogs=[];
const sessions=new Map();
const liara=new Liara(()=>config);
const app=express();app.disable('x-powered-by');
// Keep same-origin form navigation origins observable for the login Origin gate.
app.use(helmet({referrerPolicy:{policy:'same-origin'},contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],fontSrc:["'self'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],frameSrc:["'none'"],upgradeInsecureRequests:publicOrigin?[]:null}}}));
app.use(express.json({limit:'200kb'}));
app.use(express.urlencoded({extended:false,limit:'4kb'}));
installAccess(app,{origin:publicOrigin,passwordHash:process.env.OPERATOR_PASSWORD_HASH||hosting.passwordHash,username:process.env.OPERATOR_USERNAME||hosting.username||'rahban'});
const safe=x=>redact(x,[config.token,config.llmKey]);
const context=()=>createHash('sha256').update(`${mode}:${config.token}:${config.team}:${config.revision}`).digest('hex');
const idSchema=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,80}$/);
const portSchema=deploySettings.shape.port;
const approvals=()=>store.db.prepare('SELECT body,status FROM approvals ORDER BY rowid DESC LIMIT 100').all().map(r=>({...JSON.parse(r.body),status:r.status==='pending'&&JSON.parse(r.body).expires<Date.now()?'expired':r.status}));
const api=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
function requireMode(value){if(mode!==value)throw new Error('This action is unavailable in the selected environment.');}
function publicConfig(){return {connected:!!config.token,team:config.team,llmConfigured:!!(config.llmKey&&config.llmBase&&config.llmModel),llmBase:config.llmBase,llmModel:config.llmModel,shareEvidence:config.shareEvidence};}

// Bind local sessions to exact browser origins. No wildcard CORS and no credential in URLs.
app.use('/api',(req,res,next)=>{
  const port=process.env.PORT||4310;
  const allowed=new Set([`localhost:${port}`,`127.0.0.1:${port}`]);
  if(publicOrigin)allowed.add(new URL(publicOrigin).host);
  if(!allowed.has(req.headers.host))return res.status(403).json({error:'Host is not allowed.'});
  const origin=req.get('origin');if(origin&&![`http://localhost:${port}`,`http://127.0.0.1:${port}`,publicOrigin].includes(origin))return res.status(403).json({error:'Origin is not allowed.'});
  if(req.path==='/session'&&req.method==='GET')return next();
  const sid=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rahban_session='))?.split('=')[1];
  const session=sessions.get(sid);
  if(!session||session.expires<Date.now())return res.status(401).json({error:'Session expired. Refresh the page.'});
  if(!['GET','HEAD'].includes(req.method)&&req.get('x-csrf-token')!==session.csrf)return res.status(403).json({error:'Invalid request token.'});
  next();
});
app.get('/api/session',(req,res)=>{for(const [k,v]of sessions)if(v.expires<Date.now())sessions.delete(k);if(sessions.size>=1000)sessions.delete(sessions.keys().next().value);const sid=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');sessions.set(sid,{csrf,expires:Date.now()+86400000});res.cookie('rahban_session',sid,{httpOnly:true,secure:!!publicOrigin,sameSite:'strict',maxAge:86400000,path:'/'});res.set('Cache-Control','no-store').json({csrf});});
app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.get('/api/settings',(req,res)=>res.json(publicConfig()));
app.post('/api/settings',api(async(req,res)=>{
  const body=z.object({token:z.string().max(4000).optional(),team:z.string().max(100).optional(),llmBase:z.union([z.literal(''),z.url().startsWith('https://')]).optional(),llmKey:z.string().max(4000).optional(),llmModel:z.string().max(100).optional(),shareEvidence:z.boolean().optional()}).parse(req.body);
  // Test new Liara credentials before replacing a functioning connection.
  if(body.token){await new Liara(()=>({token:body.token,team:body.team??config.team})).apps();}
  if(body.token)config.token=body.token;
  if(body.llmKey)config.llmKey=body.llmKey;
  for(const key of ['team','llmBase','llmModel','shareEvidence'])if(body[key]!==undefined)config[key]=body[key];
  config.revision=randomUUID();store.audit('connection.updated',{liara:!!config.token,llm:!!config.llmKey});res.json(publicConfig());
}));
app.post('/api/disconnect',(req,res)=>{config.token='';config.llmKey='';config.revision=randomUUID();mode='demo';store.audit('connection.disconnected',{});res.json({ok:true});});
app.post('/api/mode',(req,res)=>{const next=z.enum(['demo','live']).parse(req.body.mode);if(next==='live'&&!config.token)throw new Error('Connect your Liara account first.');mode=next;res.json({mode});});
app.get('/api/state',api(async(req,res)=>{
  const probes=store.db.prepare('SELECT service,at,ok,ms,code FROM probes WHERE at>? AND mode=? ORDER BY at DESC LIMIT 900').all(Date.now()-3600000,mode).reverse();
  res.json({mode,hosting:{public:!!publicOrigin,persistent:!!hosting.dataDir},settings:publicConfig(),services:store.list('service').filter(s=>s.mode===mode),jobs:store.list('job').filter(j=>j.mode===mode),incidents:store.list('incident').filter(j=>j.mode===mode),approvals:approvals().filter(j=>j.mode===mode),probes,audit:store.db.prepare('SELECT seq,body,hash FROM audit ORDER BY seq DESC LIMIT 40').all().map(r=>({...JSON.parse(r.body),seq:r.seq,hash:r.hash})),demoFault,limits:['Dockerfile and Node.js deployments are supported.','Health checks use HTTP requests.','Application CPU and RAM metrics are unavailable.','Manage domains and plan changes in Liara. Automatic rollback is unavailable.']});
}));
app.post('/api/sync',api(async(req,res)=>{
  requireMode('live');const apps=await liara.apps(),current=new Set();
  for(const p of apps){const id=String(p.project_id||p.name||p._id);if(!idSchema.safeParse(id).success)continue;current.add(id);const prior=store.get('service',id,'live');store.put('service',{...prior,id,name:p.name||id,platform:p.type||p.platform||'unknown',mode:'live',provider:'Liara',domain:/^[a-z0-9-]+$/.test(p.name||id)?`${p.name||id}.liara.run`:null,state:p.status||p.state||'unknown'});}
  for(const prior of store.list('service').filter(s=>s.mode==='live'&&!current.has(s.id))){store.db.prepare("DELETE FROM records WHERE kind='service' AND id=?").run('live:'+prior.id);}
  store.audit('liara.synced',{count:apps.length});res.json({count:apps.length});
}));
app.get('/api/plans',api(async(req,res)=>{requireMode('live');const plans=await liara.plans();const source=typeof req.query.sourceId==='string'?store.get('source',req.query.sourceId):null;res.json({...plans,recommendation:recommendPlan(plans,source?.sizing)});}));
app.get('/api/logs/:id',api(async(req,res)=>{
  const id=idSchema.parse(req.params.id);const service=store.get('service',id,mode);if(!service||service.mode!==mode)throw new Error('Service not found in this environment.');
  const logs=mode==='demo'?demoLogs:await liara.logs(id);res.json({logs:logs.map(l=>({...l,line:safe(l.line)})),source:mode==='demo'?'local-sandbox':'liara-api'});
}));

async function saveSource(files,label){const info=inspect(files),bytes=await archive(files),id=randomUUID();writeFileSync(join(data,'sources',`${id}.tar.gz`),bytes);return store.put('source',{id,label,...info,sha256:digest(bytes)});}
app.post('/api/sources/sample',api(async(req,res)=>res.json(await saveSource(sampleFiles,'Sample project'))));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1}});
app.post('/api/sources/upload',upload.single('file'),api(async(req,res)=>{if(!req.file)throw new Error('Choose a ZIP file.');res.json(await saveSource(unpackZip(req.file.buffer),safe(req.file.originalname)));}));
app.post('/api/sources/github',api(async(req,res)=>{
  const repo=z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/).parse(req.body.url).replace(/\/$/,'');
  const branch=z.string().regex(/^[\w./-]{1,120}$/).parse(req.body.branch||'main');
  const response=await fetch(`https://codeload.github.com/${new URL(repo).pathname.slice(1)}/zip/refs/heads/${branch}`,{signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw new Error('Public repository or branch not found.');let size=0;const chunks=[];
  for await(const c of response.body){size+=c.length;if(size>10*1024*1024)throw new Error('Archive limit is 10 MB.');chunks.push(c);}
  res.json(await saveSource(unpackZip(Buffer.concat(chunks)),repo));
}));

app.post('/api/deployment/preview',api(async(req,res)=>{
  const body=z.object({sourceId:z.string().uuid(),settings:deploySettings.nullish()}).parse(req.body);
  const source=store.get('source',body.sourceId);if(!source)throw new Error('Source not found.');
  res.json(previewDeployment(source,body.settings));
}));

app.post('/api/proposals',api(async(req,res)=>{
  const body=z.object({type:z.enum(['deploy','restart','restore-demo','create-app']),target:idSchema,sourceId:z.string().uuid().optional(),platform:z.enum(['node','docker']).optional(),port:portSchema,settings:deploySettings.nullish(),planID:z.string().max(100).optional(),bundlePlanID:z.string().max(100).optional()}).parse(req.body);
  const service=store.get('service',body.target,mode);let title,risk,impact,rollback,payload={...body},cost=null;
  if(body.type==='restore-demo'){requireMode('demo');if(body.target!=='sandbox-store')throw new Error('Invalid sandbox target.');title='Restore sandbox';risk='medium';impact='Restore the sandbox configuration, then run three health checks.';rollback='Changes affect only the local sandbox.';}
  else{
    requireMode('live');
    if(body.type==='create-app'){
      const plans=await liara.plans(),p=plans.projects?.[body.planID],bundle=plans.projectBundlePlans?.[body.planID]?.[body.bundlePlanID];
      if(!p?.available||!bundle?.available)throw new Error('This plan or bundle is unavailable in the connected account.');
      cost={hourly:p.price,monthlyEstimate:Number(p.price)*720+Number(bundle.displayPrice||0),unit:'Toman',assumption:'Estimate: 720 hours plus bundle. Actual charges depend on Liara pricing and usage.'};
      if(!Number.isFinite(cost.monthlyEstimate))throw new Error('Liara returned no valid price. Service creation stopped.');
      payload={name:body.target,platform:body.platform||'docker',planID:body.planID,bundlePlanID:body.bundlePlanID};title=`Create ${payload.platform==='docker'?'Docker':'Node.js'} on Liara`;risk='high';impact='Creates a billable service. Account top-up is your responsibility.';rollback='Manage or delete the service in Liara.';
    }else{
      if(!service||service.mode!=='live')throw new Error('Refresh the Liara service list first.');
      if(body.type==='deploy'){
        const source=store.get('source',body.sourceId||'');if(!source?.ready)throw new Error('Choose a valid project.');
        if(service.platform!==source.platform)throw new Error('The service platform does not match the project. Choose or create a matching service.');
        // Preserve environment by not sending envs. Disk-backed apps need an explicit migration procedure.
        const details=await liara.details(body.target);if(details?.disks?.length)throw new Error('Deployment to services with persistent disks is not supported yet.');
        const envs=Array.isArray(details?.envs)?details.envs:[];
        const configured=new Set(envs.map(e=>e.key||e.name));const missing=(source.requiredEnv??source.env).filter(name=>!configured.has(name));
        if(missing.length)throw new Error(`Set ${missing.join(', ')} in Liara, then prepare a new deployment.`);
        const settings=resolveSettings(source,body.settings,body.port);
        payload={...body,platform:source.platform,port:settings.port,settings,sha256:source.sha256};title='Deploy to Liara';risk='high';impact='Uploads the reviewed files and creates a release. The service URL may be public.';rollback='No automatic rollback. Manage prior releases in Liara. Database migrations are not run.';
      }else{title='Restart service';risk='high';impact='May briefly interrupt the service. A restart may not fix the underlying problem.';rollback='A restart cannot be undone. Health is checked afterward.';}
    }
  }
  const row=createApproval(store,{type:body.type,target:body.target,title,risk,impact,rollback,payload,cost,mode},context());res.json(row);
}));
app.post('/api/approvals/:id/reject',api(async(req,res)=>{const result=store.db.prepare("UPDATE approvals SET status='rejected' WHERE id=? AND status='pending' AND context=?").run(req.params.id,context());if(!result.changes)throw new Error('This request cannot be rejected in the current account.');store.audit('approval.rejected',{id:req.params.id});res.json({ok:true});}));
app.post('/api/approvals/:id/execute',api(async(req,res)=>{
  const proposed=store.db.prepare('SELECT body FROM approvals WHERE id=?').get(req.params.id);
  if(proposed&&store.list('job').some(j=>j.target===JSON.parse(proposed.body).target&&j.status==='running'))throw new Error('Another action is running on this service. Wait for it to finish.');
  const action=claimApproval(store,req.params.id,context(),req.body.confirmation);
  const job=store.put('job',{mode,settings:action.payload.settings,type:action.type,target:action.target,title:action.title,status:'running',steps:[{title:'Approval recorded',status:'done'}],approvalId:action.id});
  // Capture credentials and mode at claim time; later UI changes cannot redirect an approved operation.
  const configSnapshot={token:config.token,team:config.team};const adapter=new Liara(()=>configSnapshot);
  runOperation(action,job,adapter).catch(()=>{});res.status(202).json(job);
}));
function jobStep(job,title,status='done'){job.steps.push({title,status,at:new Date().toISOString()});store.put('job',job);}
async function verifyService(id,count=3,environment=mode,settings){return (await waitForHealthy(()=>probe(id,environment,settings),{required:count,attempts:environment==='live'?15:3,interval:environment==='live'?2000:1200})).healthy;}
function rememberDeployment(target,environment,settings){
  const service=store.get('service',target,environment);
  if(service)store.put('service',{...service,settings,state:'running'});
}
async function runOperation(action,job,adapter){
  try{
    const p=action.payload;
    if(action.type==='restore-demo'){
      demoFault=null;demoLogs.push({at:Date.now(),line:'INFO configuration restored to healthy baseline'});jobStep(job,'Sandbox configuration restored');
    }else if(action.type==='restart'){await adapter.restart(action.target);jobStep(job,'Liara accepted the restart');await new Promise(r=>setTimeout(r,4000));}
    else if(action.type==='create-app'){
      const current=await adapter.plans();const plan=current.projects?.[p.planID],bundle=current.projectBundlePlans?.[p.planID]?.[p.bundlePlanID];
      const currentCost=Number(plan?.price)*720+Number(bundle?.displayPrice||0);
      if(!plan?.available||!bundle?.available||currentCost!==action.cost.monthlyEstimate)throw new Error('Plan availability or price changed. Prepare a new proposal.');
      await adapter.create(p);store.put('service',{id:action.target,name:action.target,mode:'live',platform:p.platform,domain:`${action.target}.liara.run`,state:'created',provider:'Liara'});jobStep(job,'Liara confirmed service creation');job.status='succeeded';job.message='Service created. You can deploy the project now.';
    }else if(action.type==='deploy'){
      const source=readFileSync(join(data,'sources',`${p.sourceId}.tar.gz`));if(digest(source)!==p.sha256)throw new Error('Source checksum changed. Deployment stopped.');
      jobStep(job,'Approved source checksum verified');
      const release=await adapter.deploy(action.target,source,p.platform,p.port,title=>jobStep(job,title),p.settings);job.releaseId=release.releaseID;if(!job.releaseId)throw new Error('Liara returned no release ID. Check the Liara console.');jobStep(job,'Release created in Liara');
      let ready=false;for(let n=0;n<120;n++){const r=await adapter.release(job.releaseId);const state=r.release?.state;if(['FAILED','UNHEALTHY'].includes(state))throw Object.assign(new Error(`Liara release is ${state}. Check the logs.`),{releaseFailed:true});if(state==='READY'){ready=true;break;}await new Promise(r=>setTimeout(r,5000));}
      if(!ready)throw new Error('Release polling timed out. Check its status before retrying.');jobStep(job,'Liara release is READY');
      rememberDeployment(action.target,action.mode,p.settings);
    }
    if(action.type!=='create-app'){
      const healthy=await verifyService(action.target,3,action.mode,p.settings);jobStep(job,'Three HTTP health checks',healthy?'done':'failed');job.status=healthy?'succeeded':'needs_attention';job.message=healthy?'Completed. All three health checks passed.':'Action submitted, but HTTP health is not confirmed.';
      if(healthy)for(const incident of store.list('incident').filter(i=>i.target===action.target&&i.status==='open'&&i.mode===action.mode)){store.put('incident',{...incident,status:'resolved',resolved:new Date().toISOString(),resolution:job.message,jobId:job.id});}
    }
    store.put('job',job);store.db.prepare("UPDATE approvals SET status='completed' WHERE id=?").run(action.id);store.audit('operation.finished',{id:job.id,target:action.target,status:job.status});
  }catch(error){
    job.status=job.releaseId&&!error.releaseFailed?'needs_attention':'failed';job.message=safe(error.message);
    store.put('job',job);store.db.prepare('UPDATE approvals SET status=? WHERE id=?').run(job.status==='failed'?'failed':'completed',action.id);
    store.audit('operation.'+job.status,{id:job.id,target:action.target,message:job.message});
  }
}

app.post('/api/incidents',api(async(req,res)=>{
  const {target,message}=z.object({target:idSchema,message:z.string().max(2000).default('Check service health')}).parse(req.body);
  const service=store.get('service',target,mode);if(!service||service.mode!==mode)throw new Error('Service not found in this environment.');
  const atMode=mode,logs=(mode==='demo'?demoLogs:await liara.logs(target)).map(x=>({...x,line:safe(x.line)}));
  const latest=await probe(target,atMode),hypotheses=diagnose(logs,latest);
  const incident=store.put('incident',{mode:atMode,target,title:latest?.ok?'Service check':'Service is not responding correctly',status:latest?.ok?'observed':'open',severity:latest?.ok?'info':'warning',message:safe(message),logs:logs.slice(-15),probe:latest,hypotheses,engine:'rules',advice:null,limitation:'Based on logs and HTTP responses. Application CPU and RAM metrics are unavailable.'});
  try{const advice=await llmAdvice(config,{message:incident.message,logs:incident.logs,probe:latest,hypotheses});if(advice){incident.advice=safe(advice);incident.engine='llm';}}catch(e){incident.modelError=safe(e.message);}
  store.put('incident',incident);store.audit('incident.investigated',{id:incident.id,target,engine:incident.engine});res.json(incident);
}));
app.post('/api/demo/fault',(req,res)=>{requireMode('demo');demoFault=z.enum(['error','slow']).parse(req.body.type);store.audit('sandbox.fault_injected',{type:demoFault});res.json({ok:true});});
app.get('/api/incidents/:id/report',(req,res)=>{
  const i=store.get('incident',req.params.id);if(!i||i.mode!==mode)return res.status(404).end();
  const report=`# Rahban incident report\n\n- Service: ${i.target}\n- Environment: ${i.mode}\n- Time: ${i.created}\n- Status: ${i.status}\n- Engine: ${i.engine}\n\n## Evidence\nHTTP: ${i.probe?.code??'unknown'}\n\n${i.hypotheses.map(h=>`### ${h.title}\n${h.evidence}\n\n${h.next}`).join('\n\n')}\n\n## Model analysis\n${i.advice||'No model connected. Analysis uses local rules.'}\n\n## Recovery\n${i.resolution||'Recovery has not been confirmed.'}\n\n## Limitations\n${i.limitation}\n\n## Suggested follow-up\n- Test configuration before deployment\n- Review the health check conditions\n`;
  res.set('Content-Type','text/markdown; charset=utf-8').set('Content-Disposition',`attachment; filename="incident-${i.id}.md"`).send(report);
});

// Actual local sandbox response is probed over HTTP; no fabricated historic metrics.
app.get('/sandbox',async(req,res)=>{
  if(demoFault==='slow')await new Promise(r=>setTimeout(r,1600));
  const failed=demoFault==='error';const line=failed?'ERROR DEMO_CONFIG_INVALID: required environment configuration missing':'INFO GET /sandbox 200';
  demoLogs.push({at:Date.now(),line});if(demoLogs.length>150)demoLogs.shift();
  res.status(failed?503:200).type('html').send('<html lang="en" dir="ltr"><title>Rahban Sandbox</title><body style="background:#0d1219;color:#c2ee92;padding:10vw;font:24px sans-serif"><h1>'+(failed?'Sandbox fault is active':'Sandbox is healthy')+'</h1><p>This sandbox is separate from your Liara projects.</p></body></html>');
});
async function probe(id,environment=mode,approvedSettings){
  const service=store.get('service',id,environment);if(!service)return null;
  const url=service.mode==='demo'?`http://127.0.0.1:${process.env.PORT||4310}/sandbox`:(/^[a-z0-9-]+\.liara\.run$/.test(service.domain||'')?`https://${service.domain}`:null);
  if(!url)return null;
  const settings=resolveSettings(null,approvedSettings??service.settings);
  const target=service.mode==='demo'?url:new URL(settings.healthPath,url).href;
  const result=await probeHttp(target,{timeoutMs:settings.healthTimeoutMs});
  const row={service:id,at:Date.now(),...result};
  store.db.prepare('INSERT INTO probes(service,at,ok,ms,code,mode) VALUES(?,?,?,?,?,?)').run(id,row.at,row.ok,row.ms,row.code,environment);
  return row;
}
app.post('/api/probe/:id',api(async(req,res)=>{const service=store.get('service',req.params.id,mode);if(!service||service.mode!==mode)throw new Error('Service not found.');res.json(await probe(service.id));}));
app.post('/api/jobs/:id/verify',api(async(req,res)=>{
  const job=store.get('job',req.params.id);
  if(!job||job.mode!==mode||job.status!=='needs_attention')throw new Error('This operation is not awaiting verification.');
  if(job.releaseId){const release=await liara.release(job.releaseId);if(release.release?.state!=='READY')throw new Error('Release is not READY. Check its status in Liara.');}
  if(job.type==='deploy')rememberDeployment(job.target,job.mode,job.settings);
  const healthy=await verifyService(job.target,3,job.mode,job.settings);jobStep(job,'Recheck: three consecutive healthy responses',healthy?'done':'failed');
  job.status=healthy?'succeeded':'needs_attention';job.message=healthy?'Deployment verified with three consecutive healthy responses.':'Service health is not confirmed yet.';
  store.put('job',job);store.audit('operation.health_verified',{id:job.id,target:job.target,healthy});
  if(healthy)for(const i of store.list('incident').filter(i=>i.mode===job.mode&&i.target===job.target&&i.status==='open'))store.put('incident',{...i,status:'resolved',resolved:new Date().toISOString(),resolution:job.message,jobId:job.id});
  res.json(job);
}));
app.get('/healthz',(req,res)=>res.json({status:'ok',service:'rahban',time:new Date().toISOString()}));
app.use(express.static(join(root,'dist')));
app.get('/{*path}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'API route not found.'});if(existsSync(join(root,'dist/index.html')))return res.sendFile(join(root,'dist/index.html'));res.status(503).send('Run npm run build first.');});
app.use((error,req,res,next)=>{res.status(error instanceof z.ZodError?400:400).json({error:error instanceof z.ZodError?'Invalid input. Check the fields.':safe(error.message||'Unknown error')});});
store.put('service',{id:'sandbox-store',name:'Sample store',mode:'demo',platform:'Node.js 22',provider:'Local sandbox',domain:null,state:'running'});
const port=Number(process.env.PORT||hosting.port||4310);app.listen(port,process.env.HOST||hosting.host||'127.0.0.1',()=>{console.log(`Rahban listening on port ${port}`);probe('sandbox-store','demo');});
