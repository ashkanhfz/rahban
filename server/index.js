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
import {recommendPlan,planCatalog} from './sizing.js';
import {waitForHealthy,probeHttp,isSlowResponse} from './health.js';
import {deploySettings,resolveSettings,previewDeployment} from './deployment.js';
import {installAccess} from './access.js';
import {resolveGitHubSource,downloadGitHubArchive} from './github.js';
import {openRuntime} from './runtime.js';
import {collectServiceEvidence} from './observability.js';
import {installServiceTools} from './service-tools.js';
import {installContinuous} from './continuous.js';
import {createEnvironmentChanges,envChanges,envDigest} from './env-changes.js';
import {installManagement} from './management.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.env.RAHBAN_IGNORE_ENV!=='1')try{process.loadEnvFile(join(root,'.env'));}catch{}
const hostingFile=join(root,'hosting.private.json');
const hosting=process.env.RAHBAN_IGNORE_ENV==='1'?{}:(existsSync(hostingFile)?JSON.parse(readFileSync(hostingFile,'utf8')):{});
const publicOrigin=process.env.PUBLIC_ORIGIN||hosting.origin||'';
const data=resolve(process.env.DATA_DIR||hosting.dataDir||join(root,'data'));mkdirSync(join(data,'sources'),{recursive:true});
const store=openStore(data);
const runtime=openRuntime(store);
const appendAudit=store.audit;
let auditScope=()=>null;
store.audit=(event,detail)=>appendAudit(event,{...detail,accountScope:detail.accountScope||auditScope(),rahban:runtime.snapshot().signature,bootId:runtime.snapshot().bootId});
store.audit('rahban.started',{recovered:runtime.snapshot().recovered,previousLastSeenAt:runtime.snapshot().previousLastSeenAt});
// In-flight operations after a process crash are uncertain: never replay a cloud mutation.
store.db.prepare("UPDATE approvals SET status='interrupted' WHERE status='executing'").run();
for(const job of store.db.prepare("SELECT body FROM records WHERE kind='job' AND json_extract(body,'$.status')='running'").all().map(row=>JSON.parse(row.body)))store.put('job',{...job,status:'interrupted',message:'Interrupted. Check Liara before retrying.'});
const config={token:process.env.LIARA_API_TOKEN||'',team:process.env.LIARA_TEAM_ID||'',llmBase:process.env.LLM_BASE_URL||'',llmKey:process.env.LLM_API_KEY||'',llmModel:process.env.LLM_MODEL||'',shareEvidence:process.env.LLM_SHARE_EVIDENCE==='true',revision:randomUUID()};
let mode='demo',demoFault=null;const demoLogs=[];
const sessions=new Map();
const liara=new Liara(()=>config);
const environmentChanges=createEnvironmentChanges();
const app=express();app.disable('x-powered-by');
app.use((req,res,next)=>{const identity=runtime.snapshot();res.set('X-Rahban-Instance',identity.instanceId).set('X-Rahban-Boot',identity.bootId);next();});
// Keep same-origin form navigation origins observable for the login Origin gate.
app.use(helmet({referrerPolicy:{policy:'same-origin'},contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],fontSrc:["'self'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],frameSrc:["'none'"],upgradeInsecureRequests:publicOrigin?[]:null}}}));
app.use(express.json({limit:'200kb'}));
app.use(express.urlencoded({extended:false,limit:'4kb'}));
installAccess(app,{origin:publicOrigin,passwordHash:process.env.OPERATOR_PASSWORD_HASH||hosting.passwordHash,username:process.env.OPERATOR_USERNAME||hosting.username||'rahban'});
const safe=x=>redact(x,[config.token,config.llmKey]);
const context=()=>createHash('sha256').update(`${mode}:${config.token}:${config.team}:${config.revision}`).digest('hex');
const accountScope=(credentials=config)=>createHash('sha256').update(JSON.stringify([credentials.token,credentials.team||''])).digest('hex');
auditScope=accountScope;
function currentService(id,environment=mode,scope=accountScope()){
  const service=store.get('service',id,environment);
  if(!service||environment==='live'&&service.accountScope!==scope)throw new Error('Refresh the apps for this account first.');
  return service;
}
const httpError=(status,code,message)=>Object.assign(new Error(message),{status,code});
function jobApproval(job){
  const row=store.db.prepare('SELECT body,context FROM approvals WHERE id=?').get(job.approvalId);
  if(!row)throw httpError(404,'RETRY_APPROVAL_MISSING','The original approval is unavailable. Import the project again.');
  if(job.accountScope?job.accountScope!==accountScope():row.context!==context())throw httpError(409,'RETRY_CONTEXT_CHANGED','This operation belongs to another connection, or its legacy connection cannot be verified. Reconnect the original account or import the project again.');
  return JSON.parse(row.body);
}
async function networkOptions(adapter=liara){
  try{return {networks:await adapter.networks()};}
  catch(error){if([404,405].includes(error.status))return {networks:null,networkWarning:'This Liara API does not expose network selection. Creation will use its legacy network behavior.'};throw error;}
}
async function selectedNetwork(adapter,requested){
  const {networks}=await networkOptions(adapter);
  if(networks===null){if(requested)throw httpError(409,'NETWORK_UNVERIFIED','The selected network cannot be verified. Refresh the available plans.');return undefined;}
  if(!networks.length)throw httpError(409,'NETWORK_REQUIRED','Liara returned no private networks for this account or team. Check Settings and refresh networks. Create a network in Liara only if this account has none.');
  const selected=requested?networks.find(network=>network._id===requested):networks.length===1?networks[0]:null;
  if(!selected?._id)throw httpError(409,'NETWORK_REQUIRED','Select an existing private network from this Liara account.');
  return selected._id;
}
const idSchema=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,80}$/);
const portSchema=deploySettings.shape.port;
const approvals=()=>store.db.prepare('SELECT body,status FROM approvals ORDER BY rowid DESC LIMIT 100').all().map(r=>({...JSON.parse(r.body),status:r.status==='pending'&&JSON.parse(r.body).expires<Date.now()?'expired':r.status}));
const api=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
function requireMode(value){if(mode!==value)throw new Error('This action is unavailable in the selected environment.');}
function publicConfig(){return {connected:!!config.token,connectionId:config.revision,team:config.team,llmConfigured:!!(config.llmKey&&config.llmBase&&config.llmModel),llmBase:config.llmBase,llmModel:config.llmModel,shareEvidence:config.shareEvidence};}

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
  const probes=store.db.prepare("SELECT service,at,ok,ms,code FROM probes WHERE at>? AND mode=? AND (mode='demo' OR accountScope=?) ORDER BY at DESC LIMIT 900").all(Date.now()-3600000,mode,accountScope()).reverse();
  const visible=row=>row.mode===mode&&(mode!=='live'||row.accountScope===accountScope());
  const activeJobs=store.db.prepare("SELECT body FROM records WHERE kind='job' AND json_extract(body,'$.type')<>'check' AND json_extract(body,'$.status') IN ('running','needs_attention','interrupted')").all().map(row=>JSON.parse(row.body));
  const jobs=[...new Map([...store.list('job'),...activeJobs].filter(row=>visible(row)&&!row.hidden).map(row=>[row.id,row])).values()];
  res.json({mode,runtime:runtime.snapshot(),hosting:{public:!!publicOrigin,persistent:true},settings:publicConfig(),services:store.list('service').filter(visible),jobs,incidents:store.list('incident').filter(visible),approvals:approvals().filter(visible),probes,audit:store.db.prepare('SELECT seq,body,hash FROM audit ORDER BY seq DESC LIMIT 40').all().map(r=>({...JSON.parse(r.body),seq:r.seq,hash:r.hash})).filter(row=>mode!=='live'||row.detail?.accountScope===accountScope()),demoFault,limits:['Dockerfile and Node.js deployments are supported.','Health checks use HTTP requests.','CPU and RAM reports depend on the Liara API; undocumented units are shown as raw values.','DNS and plan changes are guided in Liara. Environment edits require approval and restart the app. Automatic rollback is unavailable.']});
}));
app.post('/api/sync',api(async(req,res)=>{
  requireMode('live');const credentials={...config},scope=accountScope(credentials),apps=await new Liara(()=>credentials).apps(),current=new Set();
  if(scope!==accountScope()||mode!=='live')throw new Error('Connection changed. Refresh the apps again.');
  for(const p of apps){const id=String(p.project_id||p.name||p._id);if(!idSchema.safeParse(id).success)continue;current.add(id);const saved=store.get('service',id,'live'),prior=saved?.accountScope===scope?saved:{};store.put('service',{...prior,id,name:p.name||id,platform:p.type||p.platform||'unknown',mode:'live',accountScope:scope,provider:'Liara',domain:/^[a-z0-9-]+$/.test(p.name||id)?`${p.name||id}.liara.run`:null,state:p.status||p.state||'unknown'});}
  for(const prior of store.list('service').filter(s=>s.mode==='live'&&s.accountScope===scope&&!current.has(s.id))){store.db.prepare("DELETE FROM records WHERE kind='service' AND id=?").run('live:'+prior.id);}
  store.audit('liara.synced',{count:apps.length});res.json({count:apps.length});
}));
app.get('/api/plans',api(async(req,res)=>{requireMode('live');const [plans,networks]=await Promise.all([liara.plans(),networkOptions()]);const source=typeof req.query.sourceId==='string'?store.get('source',req.query.sourceId):null;res.json({...plans,...networks,catalog:planCatalog(plans),recommendation:recommendPlan(plans,source?.sizing)});}));
app.get('/api/logs/:id',api(async(req,res)=>{
  const id=idSchema.parse(req.params.id),environment=mode,credentials={...config},scope=accountScope(credentials);currentService(id,environment,scope);
  const logs=environment==='demo'?demoLogs:await new Liara(()=>credentials).logs(id);
  if(mode!==environment||scope!==accountScope())throw new Error('Connection changed. Reload logs for the selected app.');
  res.json({logs:logs.map(l=>({...l,line:redact(l.line,[credentials.token,credentials.llmKey])})),source:environment==='demo'?'local-sandbox':'liara-api'});
}));

async function saveSource(files,label,metadata={}){const info=inspect(files),bytes=await archive(files),id=randomUUID();writeFileSync(join(data,'sources',`${id}.tar.gz`),bytes);return store.put('source',{id,label,...info,...metadata,sha256:digest(bytes),rahban:runtime.snapshot().signature});}
async function importGitHub(github){return saveSource(unpackZip(await downloadGitHubArchive(github)),github.repo,{github});}
app.post('/api/sources/sample',api(async(req,res)=>res.json(await saveSource(sampleFiles,'Sample project'))));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1}});
app.post('/api/sources/upload',upload.single('file'),api(async(req,res)=>{if(!req.file)throw new Error('Choose a ZIP file.');res.json(await saveSource(unpackZip(req.file.buffer),safe(req.file.originalname)));}));
app.post('/api/sources/github',api(async(req,res)=>{
  const github=await resolveGitHubSource(req.body.url,req.body.branch||undefined);res.json(await importGitHub(github));
}));
app.get('/api/sources/:id',api(async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id),source=store.get('source',id);
  if(!source)throw httpError(404,'SOURCE_NOT_FOUND','The saved project is unavailable. Import it again.');
  let bytes;try{bytes=readFileSync(join(data,'sources',`${id}.tar.gz`));}
  catch{throw httpError(404,'SOURCE_ARCHIVE_MISSING','The saved project archive is unavailable. Import it again.');}
  if(digest(bytes)!==source.sha256)throw httpError(409,'SOURCE_CHANGED','The saved archive changed. Import the project again.');
  res.json(source);
}));

async function validateDeployment(target,source,adapter=liara){
  const service=currentService(target,'live',accountScope(adapter.credentials()));
  if(!source?.ready||service.platform!==source.platform)throw new Error('The service platform does not match the project. Review a new deployment.');
  const details=await adapter.details(target);
  if(!details)throw new Error('Liara returned no service details. Deployment stopped.');
  if(details?.disks?.length)throw new Error('Deployment to services with persistent disks is not supported yet.');
  const configured=new Set((Array.isArray(details?.envs)?details.envs:[]).map(env=>env.key||env.name));
  const missing=(source.requiredEnv??source.env).filter(name=>!configured.has(name));
  if(missing.length)throw new Error(`Set ${missing.join(', ')} in Liara, then prepare a new deployment.`);
}

app.post('/api/deployment/preview',api(async(req,res)=>{
  const body=z.object({sourceId:z.string().uuid(),settings:deploySettings.nullish()}).parse(req.body);
  const source=store.get('source',body.sourceId);if(!source)throw new Error('Source not found.');
  res.json(previewDeployment(source,body.settings));
}));

app.post('/api/proposals',api(async(req,res)=>{
  const capturedContext=context(),credentials={...config},scope=accountScope(credentials),adapter=new Liara(()=>credentials);
  const body=z.object({type:z.enum(['deploy','restart','restore-demo','create-app','delete-app','update-env','start-app','stop-app']),target:idSchema,sourceId:z.string().uuid().optional(),platform:z.enum(['node','docker']).optional(),port:portSchema,settings:deploySettings.nullish(),planID:z.string().max(100).optional(),bundlePlanID:z.string().max(100).optional(),network:z.string().min(1).max(100).optional(),changes:envChanges.optional()}).parse(req.body);
  const service=store.get('service',body.target,mode);let title,risk,impact,rollback,payload={...body},cost=null;
  if(body.type==='restore-demo'){requireMode('demo');if(body.target!=='sandbox-store')throw new Error('Invalid sandbox target.');title='Restore sandbox';risk='medium';impact='Restore the sandbox configuration, then run three health checks.';rollback='Changes affect only the local sandbox.';}
  else{
    requireMode('live');
    if(body.type==='create-app'){
      const plans=await adapter.plans(),p=plans.projects?.[body.planID],bundle=plans.projectBundlePlans?.[body.planID]?.[body.bundlePlanID];
      if(!p?.available||!bundle?.available)throw new Error('This plan or bundle is unavailable in the connected account.');
      const catalogPlan=planCatalog(plans).find(plan=>plan.planID===body.planID),catalogBundle=catalogPlan?.bundles.find(b=>b.bundlePlanID===body.bundlePlanID);
      if(!catalogPlan?.selectable||catalogBundle?.monthlyPrice==null)throw new Error('Liara returned no valid price. Service creation stopped.');
      cost={hourly:Number(p.price),monthlyBase:catalogPlan.monthlyBase,bundleMonthly:catalogBundle.monthlyPrice,monthlyEstimate:catalogPlan.monthlyBase+catalogBundle.monthlyPrice,unit:'Toman',assumption:'Estimate: 720 hours plus bundle. Actual charges depend on Liara pricing and usage.'};
      if(!Number.isFinite(cost.monthlyEstimate))throw new Error('Liara returned no valid price. Service creation stopped.');
      const network=await selectedNetwork(adapter,body.network),source=body.sourceId?store.get('source',body.sourceId):null;
      if(body.sourceId&&!source?.ready)throw httpError(400,'INVALID_SOURCE','Choose a valid project before creating its service.');
      if(source&&body.platform&&body.platform!==source.platform)throw httpError(400,'PLATFORM_MISMATCH','The service platform must match the selected project.');
      payload={name:body.target,platform:source?.platform||body.platform||'docker',planID:body.planID,bundlePlanID:body.bundlePlanID,...(network?{network}:{}),...(source?{sourceId:source.id,settings:resolveSettings(source,body.settings,body.port)}:{})};title=`Create ${payload.platform==='docker'?'Docker':'Node.js'} on Liara`;risk='high';impact='Creates a billable service. Account top-up is your responsibility.';rollback='Manage or delete the service in Liara.';
    }else{
      currentService(body.target,'live');
      if(body.type==='deploy'){
        const source=store.get('source',body.sourceId||'');if(!source?.ready)throw new Error('Choose a valid project.');
        await validateDeployment(body.target,source,adapter);
        const settings=resolveSettings(source,body.settings,body.port);
        payload={...body,platform:source.platform,port:settings.port,settings,sha256:source.sha256};title='Deploy to Liara';risk='high';impact='Uploads the reviewed files and creates a release. The service URL may be public.';
        rollback='No automatic rollback. Manage prior releases in Liara. Database migrations are not run.';
      }else if(body.type==='delete-app'){
        payload={};title='Delete app from Liara';risk='high';impact='Permanently deletes this app and its attached storage. The website will stop and app data may be lost. Back up anything you need first.';rollback='This deletion cannot be undone. Removing an app does not remove separately billed databases or other services.';
      }else if(body.type==='update-env'){
        payload=await environmentChanges.prepare(adapter,body.target,body.changes);title='Update environment variables';risk='high';impact='Changes the listed variables and restarts the app. The website may briefly be unavailable.';rollback='Restore previous values in Liara if needed. Secret values are not saved in Rahban history.';
      }else if(body.type==='stop-app'||body.type==='start-app'){
        payload={};title=body.type==='stop-app'?'Stop app':'Start app';risk='high';impact=body.type==='stop-app'?'Stops the app. Its website will be unavailable; stopping does not guarantee that all billing stops.':'Starts the app with its current code and configuration.';rollback=body.type==='stop-app'?'You can request a start later.':'You can request a stop later.';
      }else{payload={};title='Restart service';risk='high';impact='May briefly interrupt the service. A restart may not fix the underlying problem.';rollback='A restart cannot be undone. Health is checked afterward.';}
    }
  }
  if(context()!==capturedContext)throw new Error('Connection changed. Review the operation again.');
  const row=createApproval(store,{type:body.type,target:body.target,title,risk,impact,rollback,payload,cost,mode,accountScope:scope},capturedContext);res.json(row);
}));
app.post('/api/approvals/:id/reject',api(async(req,res)=>{const result=store.db.prepare("UPDATE approvals SET status='rejected' WHERE id=? AND status='pending' AND context=?").run(req.params.id,context());if(!result.changes)throw new Error('This request cannot be rejected in the current account.');store.audit('approval.rejected',{id:req.params.id});res.json({ok:true});}));
function executeApproval(id,confirmation){
  const proposed=store.db.prepare('SELECT body FROM approvals WHERE id=?').get(id);
  if(proposed){
    const target=JSON.parse(proposed.body).target;
    const previous=store.db.prepare("SELECT body FROM records WHERE kind='job' AND json_extract(body,'$.target')=? AND json_extract(body,'$.mode')=? AND (?='demo' OR json_extract(body,'$.accountScope')=?) AND json_extract(body,'$.status') IN ('running','needs_attention','interrupted')").all(target,mode,mode,accountScope()).map(row=>JSON.parse(row.body));
    const unresolved=previous.some(job=>job.type!=='check'&&(
      job.status==='running'||['needs_attention','interrupted'].includes(job.status)&&(
        job.createRequested||job.mutationRequested&&!job.providerConfirmed&&!(job.type==='restart'&&job.providerAccepted)||
        (job.releaseRequested||job.releaseId)&&!job.releaseFailed&&!job.releaseReady&&!job.steps?.some(step=>step.title==='Liara release is READY'&&step.status==='done')
      )
    ));
    if(unresolved)throw new Error('An earlier action is running or its outcome is unconfirmed. Verify that operation before starting another action.');
  }
  const action=claimApproval(store,id,context(),confirmation);
  const job=createJob(action);
  // Capture credentials and mode at claim time; later UI changes cannot redirect an approved operation.
  const configSnapshot={token:config.token,team:config.team};const adapter=new Liara(()=>configSnapshot);
  runOperation(action,job,adapter).catch(()=>{});return job;
}
app.post('/api/approvals/:id/execute',api(async(req,res)=>res.status(202).json(executeApproval(req.params.id,req.body.confirmation))));
function createJob(action){return store.put('job',{mode:action.mode,accountScope:accountScope(),settings:action.payload.settings,type:action.type,target:action.target,title:action.title||'Deploy to Liara',status:'running',steps:[{title:'Approval recorded',status:'done'}],approvalId:action.id,rahban:runtime.snapshot().signature,bootId:runtime.snapshot().bootId});}
function jobStep(job,title,status='done'){job.steps.push({title,status,at:new Date().toISOString()});store.put('job',job);}
function jobStage(job,stage){job.stage=stage;store.put('job',job);}
function operationMessage(error,job){
  if(job.type==='update-env'&&(error.providerMessage||error.code?.startsWith('LIARA_')))return `Liara could not confirm the environment change. Review the configuration in Liara and verify this operation before retrying.${error.status?' (HTTP '+error.status+')':''}`;
  return safe(error.message);
}
function failureDetails(error,job){
  let nextStep=job.status==='needs_attention'?'Verify the existing operation and check the Liara console before requesting another action.':({
    'Plan and network validation':'Refresh plans and networks, then review a new creation proposal.',
    'App creation':'Review the app name, plan and network before requesting a new approval.',
    'Project validation':'Correct the project or destination configuration, then review a new deployment.',
    'Source upload':'Check the project archive and connection, then review a new deployment.',
    'Release creation':'Review the release settings and Liara console before preparing another deployment.',
    'Release build':'Open this release and its build logs in the Liara console. Detailed build output is unavailable here; fix the reported error before reviewing a new deployment.',
    'Release health':'Inspect app runtime logs, the start command and health configuration in Liara. Fix the cause before reviewing a new deployment.',
    'Environment validation':'Refresh the app configuration and enter the changes again.',
  }[job.stage]||'Refresh the app and review its configuration before requesting another approval.');
  if(error.status===401)nextStep='Reconnect in Settings with a valid Liara API token.';
  else if(error.status===402)nextStep='Top up the Liara account, then review a new proposal.';
  else if(error.status===403)nextStep='Check token permissions and the selected team in Settings.';
  else if(error.status===409&&job.stage==='App creation')nextStep='Choose a different app name, then review and approve a new creation request.';
  return {code:error.code||(error.releaseFailed?'RELEASE_FAILED':'OPERATION_FAILED'),stage:job.stage||'Operation',nextStep,...(error.status?{status:error.status}:{}),...(error.providerMessage&&job.type!=='update-env'?{providerMessage:safe(error.providerMessage).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,500)}:{})};
}
function releaseFailure(state,job){
  if(state==='UNHEALTHY')jobStage(job,'Release health');
  return Object.assign(new Error(state==='UNHEALTHY'?'Liara marked the release UNHEALTHY. Detailed runtime error evidence is unavailable here.':'Liara marked the release FAILED. Detailed build output is unavailable here.'),{releaseFailed:true,code:state==='UNHEALTHY'?'RELEASE_UNHEALTHY':'RELEASE_FAILED'});
}
function failedHealth(job,result){
  const failed=result.results.filter(item=>!item?.ok),last=failed.at(-1),path=job.settings?.healthPath||'/';
  const detail=last?.code?`HTTP ${last.code} at ${path}.${last.code>=300&&last.code<400?' Redirects are not followed.':''}`:last?'No HTTP response was received. The connection may have failed or timed out.':'No supported public health endpoint was available.';
  job.failure={code:'HEALTH_UNCONFIRMED',stage:'HTTP health verification',nextStep:'Inspect the app logs, listening port and health path. Correct the cause, then verify this operation again.',...(last?.code?{status:last.code}:{})};
  return `The action was submitted, but three consecutive healthy responses were not confirmed. ${detail}`;
}
async function verifyService(id,count=3,environment=mode,settings,scope=accountScope()){return waitForHealthy(()=>probe(id,environment,settings,scope),{required:count,attempts:environment==='live'?15:3,interval:environment==='live'?2000:1200});}
function rememberDeployment(target,environment,settings,metadata={}){
  const service=store.get('service',target,environment);
  if(service&&(!metadata.accountScope||service.accountScope===metadata.accountScope))store.put('service',{...service,settings,state:'running',rahban:runtime.snapshot().signature,...metadata});
}
function pauseAppSchedules(target,scope,message){
  for(const kind of ['monitor','continuous'])for(const row of store.list(kind).filter(row=>row.target===target&&row.accountScope===scope)){
    store.put(kind,{...row,enabled:false,nextRun:null,status:'paused',revision:randomUUID(),lastError:message});
    if(row.pendingApprovalId)store.db.prepare("UPDATE approvals SET status='rejected' WHERE id=? AND status='pending'").run(row.pendingApprovalId);
  }
}
async function confirmManagement(action,job,adapter){
  const target=action.target;
  for(let attempt=0;attempt<5;attempt++){
    let confirmed=false;
    if(action.type==='delete-app'){
      const apps=await adapter.apps();confirmed=!apps.some(item=>(item.project_id||item.name||item._id)===target);
    }else if(action.type==='update-env')confirmed=envDigest(await adapter.envs(target))===action.payload.desiredDigest;
    else{const details=await adapter.details(target);confirmed=details?.scale===(action.type==='stop-app'?0:1);}
    if(confirmed){
      const service=store.get('service',target,'live');
      if(service?.accountScope===job.accountScope){
        if(action.type==='delete-app')store.db.prepare("DELETE FROM records WHERE kind='service' AND id=?").run('live:'+target);
        else if(action.type==='stop-app'||action.type==='start-app')store.put('service',{...service,state:action.type==='stop-app'?'stopped':'running'});
      }
      if(action.type==='delete-app'||action.type==='stop-app')pauseAppSchedules(target,job.accountScope,'App '+(action.type==='delete-app'?'deleted.':'stopped. Review schedules before enabling them again.'));
      job.providerConfirmed=true;
      if(action.type==='delete-app')store.db.prepare("UPDATE approvals SET status='rejected' WHERE status='pending' AND json_extract(body,'$.target')=? AND json_extract(body,'$.accountScope')=?").run(target,job.accountScope);
      jobStep(job,action.type==='delete-app'?'Liara confirms the app was removed':action.type==='update-env'?'Liara confirms the requested environment':action.type==='stop-app'?'Liara confirms the app is stopped':'Liara confirms the app is started');
      return;
    }
    if(attempt<4)await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('Liara has not confirmed the requested change yet. Verify the outcome before requesting another action.');
}
async function runOperation(action,job,adapter){
  try{
    const p=action.payload;
    if(action.type==='restore-demo'){
      jobStage(job,'Sandbox recovery');
      demoFault=null;demoLogs.push({at:Date.now(),line:'INFO configuration restored to healthy baseline'});jobStep(job,'Sandbox configuration restored');
    }else if(['delete-app','update-env','start-app','stop-app','restart'].includes(action.type)){
      const mutationStage={'delete-app':'App deletion','update-env':'Environment update','start-app':'App start','stop-app':'App stop',restart:'App restart'}[action.type];
      jobStage(job,action.type==='update-env'?'Environment validation':mutationStage);
      const requested=()=>{job.mutationRequested=true;jobStage(job,mutationStage);};
      if(action.type==='update-env')await environmentChanges.apply(adapter,action.target,p,requested);
      else{requested();await adapter[{'delete-app':'delete','start-app':'start','stop-app':'stop','restart':'restart'}[action.type]](action.target);}
      job.providerAccepted=true;jobStep(job,'Liara accepted the request');
      if(action.type==='restart')await new Promise(r=>setTimeout(r,4000));
      else{jobStage(job,'Provider state verification');await confirmManagement(action,job,adapter);}
      if(action.type==='delete-app'||action.type==='stop-app'){
        job.status='succeeded';job.message=action.type==='delete-app'?'App deleted. Scheduled checks and GitHub updates are disabled.':'App stopped. Scheduled checks and GitHub updates are paused.';
      }
    }
    else if(action.type==='create-app'){
      jobStage(job,'Plan and network validation');
      const current=await adapter.plans();const plan=current.projects?.[p.planID],bundle=current.projectBundlePlans?.[p.planID]?.[p.bundlePlanID];
      const catalogPlan=planCatalog(current).find(plan=>plan.planID===p.planID),catalogBundle=catalogPlan?.bundles.find(b=>b.bundlePlanID===p.bundlePlanID);
      const currentCost=catalogPlan?.selectable&&catalogBundle?.monthlyPrice!=null?catalogPlan.monthlyBase+catalogBundle.monthlyPrice:null;
      if(!plan?.available||!bundle?.available||currentCost!==action.cost.monthlyEstimate)throw new Error('Plan availability or price changed. Prepare a new proposal.');
      if(await selectedNetwork(adapter,p.network)!==p.network)throw httpError(409,'NETWORK_CHANGED','Available networks changed. Prepare a new proposal.');
      jobStep(job,'Approved plan and network verified');
      const {name,platform,planID,bundlePlanID,network}=p;job.createRequested=true;jobStage(job,'App creation');
      await adapter.create({name,platform,planID,bundlePlanID,...(network?{network}:{})});if(job.accountScope===accountScope())store.put('service',{id:action.target,name:action.target,mode:'live',accountScope:job.accountScope,platform:p.platform,domain:`${action.target}.liara.run`,state:'created',provider:'Liara'});jobStep(job,'Liara confirmed service creation');job.status='succeeded';job.message='Service created. You can deploy the project now.';
    }else if(action.type==='deploy'){
      jobStage(job,'Project validation');
      const metadata=store.get('source',p.sourceId);await validateDeployment(action.target,metadata,adapter);
      job.github=metadata.github||null;job.commit=job.github?.commit||null;
      const source=readFileSync(join(data,'sources',`${p.sourceId}.tar.gz`));if(digest(source)!==p.sha256)throw new Error('Source checksum changed. Deployment stopped.');
      jobStep(job,'Approved source checksum verified');
      jobStage(job,'Source upload');
      const release=await adapter.deploy(action.target,source,p.platform,p.port,title=>{job.releaseRequested=true;jobStep(job,title);jobStage(job,'Release creation');},{...p.settings,attribution:`${job.rahban} job:${job.id}${job.commit?' commit:'+job.commit:''}`});job.releaseId=release.releaseID;if(!job.releaseId)throw new Error('Liara returned no release ID. Check the Liara console.');jobStep(job,'Release created in Liara');
      jobStage(job,'Release build');
      let ready=false;for(let n=0;n<120;n++){const r=await adapter.release(job.releaseId);const state=r.release?.state;if(['FAILED','UNHEALTHY'].includes(state))throw releaseFailure(state,job);if(state==='READY'){ready=true;break;}await new Promise(r=>setTimeout(r,5000));}
      if(!ready)throw new Error('Release polling timed out. Check its status before retrying.');job.releaseReady=true;jobStep(job,'Liara release is READY');
      rememberDeployment(action.target,action.mode,p.settings,{github:metadata.github||null,lastJobId:job.id,accountScope:job.accountScope});
    }
    if(!['create-app','delete-app','stop-app'].includes(action.type)){
      jobStage(job,'HTTP health verification');
      const result=await verifyService(action.target,3,action.mode,p.settings,job.accountScope),{healthy}=result;jobStep(job,'Three HTTP health checks',healthy?'done':'failed');job.status=healthy?'succeeded':'needs_attention';job.message=healthy?'Completed. All three health checks passed.':failedHealth(job,result);
      if(healthy)for(const incident of store.list('incident').filter(i=>i.target===action.target&&i.status==='open'&&i.mode===action.mode&&(action.mode!=='live'||i.accountScope===job.accountScope))){store.put('incident',{...incident,status:'resolved',resolved:new Date().toISOString(),resolution:job.message,jobId:job.id});}
    }
    store.put('job',job);store.db.prepare("UPDATE approvals SET status='completed' WHERE id=?").run(action.id);store.audit('operation.finished',{id:job.id,target:action.target,accountScope:job.accountScope,status:job.status,rahban:job.rahban,commit:job.commit});
  }catch(error){
    const uncertainCreate=job.createRequested&&(!error.status||error.status>=500);
    const uncertainMutation=job.mutationRequested&&(job.providerAccepted||!error.status||error.status>=500);
    job.status=uncertainCreate||uncertainMutation||(job.releaseId||job.releaseRequested)&&!error.releaseFailed?'needs_attention':'failed';job.message=operationMessage(error,job);
    job.releaseFailed=!!error.releaseFailed;job.failure=failureDetails(error,job);jobStep(job,job.failure.stage,'failed');
    store.put('job',job);store.db.prepare('UPDATE approvals SET status=? WHERE id=?').run(job.status==='failed'?'failed':'completed',action.id);
    store.audit('operation.'+job.status,{id:job.id,target:action.target,accountScope:job.accountScope,message:job.message});
  }
}

async function investigate(target,message,useModel=true){
  const atMode=mode,credentials={...config},scope=accountScope(credentials),service=store.get('service',target,atMode);
  if(!service||service.mode!==atMode||atMode==='live'&&service.accountScope!==scope)throw new Error('Refresh the apps for this account first.');
  const sanitize=value=>redact(value,[credentials.token,credentials.llmKey]);
  const [rawEvidence,latest]=await Promise.all([
    atMode==='live'?collectServiceEvidence(new Liara(()=>credentials),target):Promise.resolve({service:{state:'running',platform:'node'},logs:demoLogs,metrics:{},limitations:['The sandbox has no infrastructure resource metrics.']}),
    probe(target,atMode,undefined,scope),
  ]);
  const evidence=JSON.parse(sanitize(JSON.stringify(rawEvidence))),logs=evidence.logs,hypotheses=diagnose(logs,latest,evidence);
  const slow=isSlowResponse(latest),needsAttention=!latest?.ok||slow;
  const incident=store.put('incident',{mode:atMode,accountScope:scope,target,title:!latest?.ok?'Service is not responding correctly':slow?'Service response is slow':'Service check',status:needsAttention?'open':'observed',severity:needsAttention?'warning':'info',message:sanitize(message),logs:logs.slice(-15),probe:latest,metrics:evidence.metrics,service:evidence.service,limitations:evidence.limitations,hypotheses,engine:'rules',advice:null,limitation:['Based on observed logs, HTTP checks and available resource reports.',...evidence.limitations].join(' ')});
  if(useModel)try{const advice=await llmAdvice(credentials,{message:incident.message,logs:incident.logs,probe:latest,metrics:evidence.metrics,limitations:evidence.limitations,hypotheses});if(advice){incident.advice=sanitize(advice);incident.engine='llm';}}catch(e){incident.modelError=sanitize(e.message);}
  store.put('incident',incident);store.audit('incident.investigated',{id:incident.id,target,engine:incident.engine});return incident;
}
app.post('/api/incidents',api(async(req,res)=>{
  const {target,message}=z.object({target:idSchema,message:z.string().max(2000).default('Check service health')}).parse(req.body);
  res.json(await investigate(target,message));
}));
app.post('/api/demo/fault',(req,res)=>{requireMode('demo');demoFault=z.enum(['error','slow']).parse(req.body.type);store.audit('sandbox.fault_injected',{type:demoFault});res.json({ok:true});});
app.get('/api/incidents/:id/report',(req,res)=>{
  const i=store.get('incident',req.params.id);if(!i||i.mode!==mode||mode==='live'&&i.accountScope!==accountScope())return res.status(404).end();
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
async function probe(id,environment=mode,approvedSettings,scope=accountScope()){
  const service=currentService(id,environment,scope);
  const url=service.mode==='demo'?`http://127.0.0.1:${process.env.PORT||4310}/sandbox`:(/^[a-z0-9-]+\.liara\.run$/.test(service.domain||'')?`https://${service.domain}`:null);
  if(!url)return null;
  const settings=resolveSettings(null,approvedSettings??service.settings);
  const target=service.mode==='demo'?url:new URL(settings.healthPath,url).href;
  const result=await probeHttp(target,{timeoutMs:settings.healthTimeoutMs});
  const row={service:id,at:Date.now(),...result};
  store.db.prepare('INSERT INTO probes(service,at,ok,ms,code,mode,accountScope) VALUES(?,?,?,?,?,?,?)').run(id,row.at,row.ok,row.ms,row.code,environment,scope);
  return row;
}
app.post('/api/probe/:id',api(async(req,res)=>{const service=store.get('service',req.params.id,mode);if(!service||service.mode!==mode)throw new Error('Service not found.');res.json(await probe(service.id));}));
app.get('/api/jobs/:id',api(async(req,res)=>{
  const job=store.get('job',req.params.id);
  if(!job||job.hidden||job.mode!==mode||mode==='live'&&job.accountScope!==accountScope())throw httpError(404,'JOB_NOT_FOUND','Operation not found in this account and environment.');
  res.json(job);
}));
app.get('/api/jobs/:id/retry',api(async(req,res)=>{
  const job=store.get('job',req.params.id);
  if(!job||job.mode!==mode)throw httpError(404,'JOB_NOT_FOUND','Operation not found in this environment.');
  const action=jobApproval(job);
  if(!['create-app','deploy'].includes(job.type))throw httpError(400,'RETRY_UNSUPPORTED','This operation does not have a deployment draft.');
  if(!['failed','succeeded'].includes(job.status)||(job.type==='deploy'&&job.status==='failed'&&(job.releaseId||job.releaseRequested)&&!job.releaseFailed))throw httpError(409,'RETRY_REQUIRES_VERIFICATION','Wait for the operation to finish, or verify its outcome before preparing another deployment.');
  if(job.type==='create-app'&&job.status==='succeeded')throw httpError(409,'SERVICE_ALREADY_CREATED','This service was already created. Select it as the deployment destination.');
  const p=action.payload,source=p.sourceId?store.get('source',p.sourceId):null;
  if((p.sourceId||job.type==='deploy')&&!source)throw httpError(404,'RETRY_SOURCE_MISSING','The saved project is unavailable. Import it again.');
  if(source){
    const path=join(data,'sources',`${source.id}.tar.gz`);
    if(!existsSync(path))throw httpError(404,'RETRY_SOURCE_MISSING','The saved project archive is unavailable. Import it again.');
    if(digest(readFileSync(path))!==(p.sha256||source.sha256))throw httpError(409,'RETRY_SOURCE_CHANGED','The saved archive changed. Import the project again.');
  }
  const create=job.type==='create-app'?{name:p.name,platform:p.platform,planID:p.planID,bundlePlanID:p.bundlePlanID,...(p.network?{network:p.network}:{})}:null;
  res.json({jobId:job.id,type:job.type,target:job.target,source,settings:p.settings||null,create});
}));
app.post('/api/jobs/:id/verify',api(async(req,res)=>{
  const job=store.get('job',req.params.id);
  if(!job||job.mode!==mode)throw httpError(404,'JOB_NOT_FOUND','Operation not found in this environment.');
  const action=jobApproval(job),scope=accountScope(),credentials={token:config.token,team:config.team},adapter=new Liara(()=>credentials);
  if(!(job.status==='needs_attention'||(job.status==='interrupted'&&(job.releaseId||job.releaseRequested||job.createRequested||job.mutationRequested))))throw httpError(409,'VERIFICATION_NOT_REQUIRED','This operation is not awaiting verification.');
  try{
  if(job.type==='create-app'){
    jobStage(job,'App creation verification');
    const apps=await adapter.apps(),found=apps.find(project=>(project.project_id||project.name)===job.target);
    if(scope!==accountScope())throw httpError(409,'RETRY_CONTEXT_CHANGED','The connection changed during verification.');
    if(!found)throw httpError(409,'CREATE_UNCONFIRMED','Service creation is still unconfirmed. Check Liara before preparing another creation request.');
    store.put('service',{id:job.target,name:job.target,mode:job.mode,accountScope:scope,platform:found.type||found.platform||action.payload.platform,domain:`${job.target}.liara.run`,state:'created',provider:'Liara'});
    job.status='succeeded';delete job.failure;job.message='Liara confirms that this service exists. Select it as your deployment destination.';jobStep(job,'Service existence verified in Liara');res.json(job);return;
  }
  if(['delete-app','update-env','start-app','stop-app'].includes(job.type)){
    jobStage(job,'Provider state verification');
    await confirmManagement(action,job,adapter);
    if(scope!==accountScope())throw httpError(409,'RETRY_CONTEXT_CHANGED','The connection changed during verification.');
    if(job.type==='delete-app'||job.type==='stop-app'){
      job.status='succeeded';delete job.failure;job.message=job.type==='delete-app'?'App deletion verified in Liara.':'App stop verified in Liara.';
      store.put('job',job);store.audit('operation.verified',{id:job.id,target:job.target,type:job.type});res.json(job);return;
    }
  }
  if(job.type==='deploy'&&!job.releaseId)throw new Error('No release ID was received. Review the release in Liara before preparing another manual deployment. HTTP checks alone cannot confirm this release.');
  if(job.releaseId){
    jobStage(job,'Release build');
    const release=await adapter.release(job.releaseId),state=release.release?.state;
    if(scope!==accountScope())throw httpError(409,'RETRY_CONTEXT_CHANGED','The connection changed during verification.');
    if(['FAILED','UNHEALTHY'].includes(state)){const error=releaseFailure(state,job);job.status='failed';job.releaseFailed=true;job.failure=failureDetails(error,job);job.message=error.message;jobStep(job,'Release failure verified in Liara','failed');res.json(job);return;}
    if(state!=='READY')throw httpError(409,'RELEASE_NOT_READY','Release is not READY. Check its status in Liara.');
    job.releaseReady=true;
  }
  if(job.type==='deploy')rememberDeployment(job.target,job.mode,job.settings,{github:job.github||null,lastJobId:job.id,accountScope:scope});
  jobStage(job,'HTTP health verification');
  const result=await verifyService(job.target,3,job.mode,job.settings,scope),{healthy}=result;jobStep(job,'Recheck: three consecutive healthy responses',healthy?'done':'failed');
  if(job.type==='restart'&&healthy)job.providerConfirmed=true;
  job.status=healthy?'succeeded':'needs_attention';if(healthy)delete job.failure;job.message=healthy?'Operation verified with three consecutive healthy responses.':failedHealth(job,result);
  store.put('job',job);store.audit('operation.health_verified',{id:job.id,target:job.target,healthy});
  if(healthy)for(const i of store.list('incident').filter(i=>i.mode===job.mode&&i.target===job.target&&i.status==='open'&&(job.mode!=='live'||i.accountScope===scope)))store.put('incident',{...i,status:'resolved',resolved:new Date().toISOString(),resolution:job.message,jobId:job.id});
  res.json(job);
  }catch(error){job.message=operationMessage(error,job);job.failure=failureDetails(error,job);jobStep(job,job.failure.stage,'failed');if(job.type==='update-env'){error.message=job.message;delete error.providerMessage;}throw error;}
}));
installManagement(app,{store,api,getMode:()=>mode,getScope:accountScope,connected:()=>!!config.token,getAdapter:()=>{const credentials={...config};return new Liara(()=>credentials);},safe});
const serviceTools=installServiceTools(app,{store,api,liara,getMode:()=>mode,getScope:accountScope,connected:()=>!!config.token,probe,investigate,safe,runtime});
const continuous=installContinuous(app,{store,api,getMode:()=>mode,getScope:accountScope,getContext:context,connected:()=>!!config.token,safe,execute:executeApproval,prepare:async(target,github,settings)=>{
  requireMode('live');
  const credentials={...config},capturedContext=context(),scope=accountScope(credentials),adapter=new Liara(()=>credentials);
  currentService(target,'live',scope);
  const source=await importGitHub(github);
  if(context()!==capturedContext)throw new Error('Connection changed during the GitHub import.');
  await validateDeployment(target,source,adapter);
  if(context()!==capturedContext)throw new Error('Connection changed during deployment validation.');
  const resolved=resolveSettings(source,settings);
  return createApproval(store,{type:'deploy',target,title:'Deploy GitHub update',risk:'high',impact:`Deploy commit ${github.commit.slice(0,7)} from ${github.branch}. This may briefly interrupt the app.`,rollback:'No automatic rollback. Review prior releases in Liara.',payload:{sourceId:source.id,platform:source.platform,port:resolved.port,settings:resolved,sha256:source.sha256},cost:null,mode:'live',accountScope:scope},capturedContext);
}});
app.get('/healthz',(req,res)=>res.set('Cache-Control','no-store').json({status:'ok',service:'rahban',time:new Date().toISOString(),runtime:runtime.snapshot()}));
app.use(express.static(join(root,'dist')));
app.get('/{*path}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'API route not found.'});if(existsSync(join(root,'dist/index.html')))return res.sendFile(join(root,'dist/index.html'));res.status(503).send('Run npm run build first.');});
app.use((error,req,res,next)=>{const status=Number.isInteger(error.status)&&error.status>=400&&error.status<600?error.status:400;res.status(status).json({error:error instanceof z.ZodError?'Invalid input. Check the fields.':safe(error.message||'Unknown error'),...(typeof error.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?{code:error.code}:{})});});
store.put('service',{id:'sandbox-store',name:'Sample store',mode:'demo',platform:'Node.js 22',provider:'Local sandbox',domain:null,state:'running'});
const port=Number(process.env.PORT||hosting.port||4310);const server=app.listen(port,process.env.HOST||hosting.host||'127.0.0.1',()=>{console.log(`Rahban listening on port ${port}`);probe('sandbox-store','demo');});
const heartbeat=setInterval(()=>runtime.heartbeat(),15000);
function shutdown(){clearInterval(heartbeat);serviceTools.stop();continuous.stop();runtime.stop();server.close();setTimeout(()=>process.exit(0),1000).unref();}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
