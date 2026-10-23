import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import {z} from 'zod';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {openStore} from './store.js';
import {createApproval,claimApproval} from './policy.js';
import {Liara} from './liara.js';
import {archive,inspect,unpackZip,sampleFiles,digest} from './source.js';
import {makeMetrics} from './metrics.js';
import {redact,diagnose,llmAdvice} from './agent.js';
import {recommendPlan} from './sizing.js';
import {waitForHealthy} from './health.js';
import {installAccess} from './access.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.env.RAHBAN_IGNORE_ENV!=='1')try{process.loadEnvFile(join(root,'.env'));}catch{}
const hostingFile=join(root,'hosting.private.json');
const hosting=process.env.RAHBAN_IGNORE_ENV==='1'?{}:(existsSync(hostingFile)?JSON.parse(readFileSync(hostingFile,'utf8')):{});
const publicOrigin=process.env.PUBLIC_ORIGIN||hosting.origin||'';
const data=resolve(process.env.DATA_DIR||hosting.dataDir||join(root,'data'));mkdirSync(join(data,'sources'),{recursive:true});
const store=openStore(data),metrics=makeMetrics();
// In-flight operations after a process crash are uncertain: never replay a cloud mutation.
store.db.prepare("UPDATE approvals SET status='interrupted' WHERE status='executing'").run();
for(const job of store.list('job').filter(j=>j.status==='running'))store.put('job',{...job,status:'interrupted',message:'فرایند قطع شد؛ وضعیت لیارا را قبل از اجرای مجدد بررسی کنید.'});
const config={token:process.env.LIARA_API_TOKEN||'',team:process.env.LIARA_TEAM_ID||'',llmBase:process.env.LLM_BASE_URL||'',llmKey:process.env.LLM_API_KEY||'',llmModel:process.env.LLM_MODEL||'',shareEvidence:process.env.LLM_SHARE_EVIDENCE==='true',revision:randomUUID()};
let mode='demo',demoFault=null,probeBusy=false;const demoLogs=[];
const sessions=new Map();
const liara=new Liara(()=>config);
const app=express();app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],fontSrc:["'self'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],frameSrc:publicOrigin?["'none'"]:['http://localhost:4311','http://127.0.0.1:4311'],upgradeInsecureRequests:publicOrigin?[]:null}}}));
app.use(express.json({limit:'200kb'}));
app.use(express.urlencoded({extended:false,limit:'4kb'}));
installAccess(app,{origin:publicOrigin,passwordHash:process.env.OPERATOR_PASSWORD_HASH||hosting.passwordHash,username:process.env.OPERATOR_USERNAME||hosting.username||'rahban'});
const safe=x=>redact(x,[config.token,config.llmKey]);
const context=()=>createHash('sha256').update(`${mode}:${config.token}:${config.team}:${config.revision}`).digest('hex');
const idSchema=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,80}$/);
const portSchema=z.coerce.number().int().min(1).max(65535);
const approvals=()=>store.db.prepare('SELECT body,status FROM approvals ORDER BY rowid DESC LIMIT 100').all().map(r=>({...JSON.parse(r.body),status:r.status==='pending'&&JSON.parse(r.body).expires<Date.now()?'expired':r.status}));
const api=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
function requireMode(value){if(mode!==value)throw new Error('این عملیات در محیط انتخاب‌شده مجاز نیست.');}
function publicConfig(){return {connected:!!config.token,team:config.team,llmConfigured:!!(config.llmKey&&config.llmBase&&config.llmModel),llmBase:config.llmBase,llmModel:config.llmModel,shareEvidence:config.shareEvidence};}

// Bind local sessions to exact browser origins. No wildcard CORS and no credential in URLs.
app.use('/api',(req,res,next)=>{
  const port=process.env.PORT||4310;
  const allowed=new Set([`localhost:${port}`,`127.0.0.1:${port}`]);
  if(publicOrigin)allowed.add(new URL(publicOrigin).host);
  if(!allowed.has(req.headers.host))return res.status(403).json({error:'Host مجاز نیست.'});
  const origin=req.get('origin');if(origin&&![`http://localhost:${port}`,`http://127.0.0.1:${port}`,publicOrigin].includes(origin))return res.status(403).json({error:'Origin مجاز نیست.'});
  if(req.path==='/session'&&req.method==='GET')return next();
  const sid=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('rahban_session='))?.split('=')[1];
  const session=sessions.get(sid);
  if(!session||session.expires<Date.now())return res.status(401).json({error:'نشست محلی منقضی شده؛ صفحه را تازه کنید.'});
  if(!['GET','HEAD'].includes(req.method)&&req.get('x-csrf-token')!==session.csrf)return res.status(403).json({error:'تأیید امنیتی درخواست معتبر نیست.'});
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
app.post('/api/mode',(req,res)=>{const next=z.enum(['demo','live']).parse(req.body.mode);if(next==='live'&&!config.token)throw new Error('ابتدا حساب لیارا را متصل کنید.');mode=next;res.json({mode});});
app.get('/api/state',api(async(req,res)=>{
  const probes=store.db.prepare('SELECT service,at,ok,ms,code FROM probes WHERE at>? AND mode=? ORDER BY at DESC LIMIT 900').all(Date.now()-3600000,mode).reverse();
  res.json({mode,hosting:{public:!!publicOrigin,persistent:!!hosting.dataDir},settings:publicConfig(),services:store.list('service').filter(s=>s.mode===mode),jobs:store.list('job').filter(j=>j.mode===mode),incidents:store.list('incident').filter(j=>j.mode===mode),approvals:approvals().filter(j=>j.mode===mode),probes,audit:store.db.prepare('SELECT seq,body,hash FROM audit ORDER BY seq DESC LIMIT 40').all().map(r=>({...JSON.parse(r.body),seq:r.seq,hash:r.hash})),demoFault,limits:['این نسخه مسیر انتشار Node.js را پشتیبانی می‌کند.','متریک‌های HTTP از بررسی مصنوعی‌اند، نه ترافیک کاربران.','CPU و RAM کنترل‌پلین با منابع اپ لیارا متفاوت‌اند.','دامنه و تغییر پلن از پنل لیارا انجام می‌شود؛ بازگشت نسخه خودکار نیست.']});
}));
app.post('/api/sync',api(async(req,res)=>{
  requireMode('live');const apps=await liara.apps(),current=new Set();
  for(const p of apps){const id=String(p.project_id||p.name||p._id);if(!idSchema.safeParse(id).success)continue;current.add(id);const prior=store.get('service',id,'live');store.put('service',{...prior,id,name:p.name||id,platform:p.type||p.platform||'unknown',mode:'live',provider:'Liara',domain:/^[a-z0-9-]+$/.test(p.name||id)?`${p.name||id}.liara.run`:null,state:p.status||p.state||'unknown'});}
  for(const prior of store.list('service').filter(s=>s.mode==='live'&&!current.has(s.id))){store.db.prepare("DELETE FROM records WHERE kind='service' AND id=?").run('live:'+prior.id);metrics.up.remove('live/'+prior.id);metrics.timestamp.remove('live/'+prior.id);}
  store.audit('liara.synced',{count:apps.length});res.json({count:apps.length});
}));
app.get('/api/plans',api(async(req,res)=>{requireMode('live');const plans=await liara.plans();const source=typeof req.query.sourceId==='string'?store.get('source',req.query.sourceId):null;res.json({...plans,recommendation:recommendPlan(plans,source?.sizing)});}));
app.get('/api/logs/:id',api(async(req,res)=>{
  const id=idSchema.parse(req.params.id);const service=store.get('service',id,mode);if(!service||service.mode!==mode)throw new Error('سرویس این محیط پیدا نشد.');
  const logs=mode==='demo'?demoLogs:await liara.logs(id);res.json({logs:logs.map(l=>({...l,line:safe(l.line)})),source:mode==='demo'?'local-sandbox':'liara-api'});
}));

async function saveSource(files,label){const info=inspect(files),bytes=await archive(files),id=randomUUID();writeFileSync(join(data,'sources',`${id}.tar.gz`),bytes);return store.put('source',{id,label,...info,sha256:digest(bytes)});}
app.post('/api/sources/sample',api(async(req,res)=>res.json(await saveSource(sampleFiles,'نمونهٔ آمادهٔ Node.js'))));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1}});
app.post('/api/sources/upload',upload.single('file'),api(async(req,res)=>{if(!req.file)throw new Error('فایل ZIP لازم است.');res.json(await saveSource(unpackZip(req.file.buffer),safe(req.file.originalname)));}));
app.post('/api/sources/github',api(async(req,res)=>{
  const repo=z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/).parse(req.body.url).replace(/\/$/,'');
  const branch=z.string().regex(/^[\w./-]{1,120}$/).parse(req.body.branch||'main');
  const response=await fetch(`https://codeload.github.com/${new URL(repo).pathname.slice(1)}/zip/refs/heads/${branch}`,{signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw new Error('ریپوی عمومی یا شاخه پیدا نشد.');let size=0;const chunks=[];
  for await(const c of response.body){size+=c.length;if(size>10*1024*1024)throw new Error('حداکثر حجم آرشیو ۱۰ مگابایت است.');chunks.push(c);}
  res.json(await saveSource(unpackZip(Buffer.concat(chunks)),repo));
}));

app.post('/api/proposals',api(async(req,res)=>{
  const body=z.object({type:z.enum(['deploy','restart','restore-demo','create-app']),target:idSchema,sourceId:z.string().uuid().optional(),port:portSchema.optional(),planID:z.string().max(100).optional(),bundlePlanID:z.string().max(100).optional()}).parse(req.body);
  const service=store.get('service',body.target,mode);let title,risk,impact,rollback,payload={...body},cost=null;
  if(body.type==='restore-demo'){requireMode('demo');if(body.target!=='sandbox-store')throw new Error('هدف آزمایشی نامعتبر است.');title='بازیابی پیکربندی سرویس آزمایشی';risk='medium';impact='تنظیم آزمایشی به وضعیت سالم برمی‌گردد؛ سه بررسی سلامت انجام می‌شود.';rollback='فقط سرویس محلی آزمایشی تغییر می‌کند.';}
  else{
    requireMode('live');
    if(body.type==='create-app'){
      const plans=await liara.plans(),p=plans.projects?.[body.planID],bundle=plans.projectBundlePlans?.[body.planID]?.[body.bundlePlanID];
      if(!p?.available||!bundle?.available)throw new Error('پلن یا بستهٔ امکانات در حساب فعلی در دسترس نیست.');
      cost={hourly:p.price,monthlyEstimate:Number(p.price)*720+Number(bundle.displayPrice||0),unit:'تومان',assumption:'برآورد ۷۲۰ ساعت + بستهٔ امکانات؛ هزینهٔ نهایی تابع تعرفه و مصرف لیاراست.'};
      if(!Number.isFinite(cost.monthlyEstimate))throw new Error('تعرفهٔ قابل استناد از لیارا دریافت نشد؛ ساخت سرویس متوقف شد.');
      payload={name:body.target,platform:'node',planID:body.planID,bundlePlanID:body.bundlePlanID};title='ساخت سرویس Node.js در لیارا';risk='high';impact='سرویس جدید ساخته می‌شود و می‌تواند هزینه داشته باشد. شارژ حساب با خود شماست.';rollback='حذف سرویس خودکار انجام نمی‌شود؛ از پنل لیارا مدیریت کنید.';
    }else{
      if(!service||service.mode!=='live')throw new Error('ابتدا سرویس را از لیارا همگام کنید.');
      if(body.type==='deploy'){
        if(service.platform!=='node')throw new Error('این مسیر انتشار فقط برای سرویس Node.js است؛ پلتفرم مقصد را بررسی کنید.');
        const source=store.get('source',body.sourceId||'');if(!source?.ready)throw new Error('یک منبع Node.js با دستور شروع معتبر انتخاب کنید.');
        // Preserve environment by not sending envs. Disk-backed apps need an explicit migration procedure.
        const details=await liara.details(body.target);if(details?.disks?.length)throw new Error('این MVP انتشار سرویس دارای دیسک را اجرا نمی‌کند؛ تنظیم دیسک باید صریحاً حفظ شود.');
        const envs=Array.isArray(details?.envs)?details.envs:[];
        const configured=new Set(envs.map(e=>e.key||e.name));const missing=source.env.filter(name=>!configured.has(name));
        if(missing.length)throw new Error(`متغیرهای ${missing.join(', ')} را ابتدا در پنل لیارا تنظیم کنید؛ سپس پیشنهاد انتشار جدید بسازید.`);
        payload={...body,platform:'node',port:body.port||3000,sha256:source.sha256};title='انتشار نسخهٔ جدید روی لیارا';risk='high';impact='فایل‌های بررسی‌شده به لیارا ارسال و نسخهٔ جدید ساخته می‌شود؛ آدرس سرویس می‌تواند عمومی باشد.';rollback='بازگشت خودکار در این MVP پیاده نشده؛ نسخهٔ قبلی را در پنل لیارا بررسی کنید. تغییر دیتابیس اجرا نمی‌شود.';
      }else{title='ری‌استارت سرویس لیارا';risk='high';impact='ممکن است سرویس برای مدت کوتاهی قطع شود. این اقدام لزوماً علت خطا را برطرف نمی‌کند.';rollback='ری‌استارت قابل واگردانی نیست؛ سلامت پس از اجرا بررسی می‌شود.';}
    }
  }
  const row=createApproval(store,{type:body.type,target:body.target,title,risk,impact,rollback,payload,cost,mode},context());res.json(row);
}));
app.post('/api/approvals/:id/reject',api(async(req,res)=>{const result=store.db.prepare("UPDATE approvals SET status='rejected' WHERE id=? AND status='pending' AND context=?").run(req.params.id,context());if(!result.changes)throw new Error('این درخواست در حساب فعلی قابل رد کردن نیست.');store.audit('approval.rejected',{id:req.params.id});res.json({ok:true});}));
app.post('/api/approvals/:id/execute',api(async(req,res)=>{
  const proposed=store.db.prepare('SELECT body FROM approvals WHERE id=?').get(req.params.id);
  if(proposed&&store.list('job').some(j=>j.target===JSON.parse(proposed.body).target&&j.status==='running'))throw new Error('عملیات دیگری روی این سرویس در حال اجراست؛ پس از پایان آن پیشنهاد جدید را بررسی کنید.');
  const action=claimApproval(store,req.params.id,context(),req.body.confirmation);
  const job=store.put('job',{mode,type:action.type,target:action.target,title:action.title,status:'running',steps:[{title:'تأیید کاربر ثبت شد',status:'done'}],approvalId:action.id});
  // Capture credentials and mode at claim time; later UI changes cannot redirect an approved operation.
  const configSnapshot={token:config.token,team:config.team};const adapter=new Liara(()=>configSnapshot);
  runOperation(action,job,adapter).catch(()=>{});res.status(202).json(job);
}));
function jobStep(job,title,status='done'){job.steps.push({title,status,at:new Date().toISOString()});store.put('job',job);}
async function verifyService(id,count=3,environment=mode){return (await waitForHealthy(()=>probe(id,environment),{required:count,attempts:environment==='live'?15:3,interval:environment==='live'?2000:1200})).healthy;}
async function runOperation(action,job,adapter){
  try{
    const p=action.payload;
    if(action.type==='restore-demo'){
      demoFault=null;demoLogs.push({at:Date.now(),line:'INFO configuration restored to healthy baseline'});jobStep(job,'پیکربندی سرویس آزمایشی بازیابی شد');
    }else if(action.type==='restart'){await adapter.restart(action.target);jobStep(job,'لیارا درخواست ری‌استارت را پذیرفت');await new Promise(r=>setTimeout(r,4000));}
    else if(action.type==='create-app'){
      const current=await adapter.plans();const plan=current.projects?.[p.planID],bundle=current.projectBundlePlans?.[p.planID]?.[p.bundlePlanID];
      const currentCost=Number(plan?.price)*720+Number(bundle?.displayPrice||0);
      if(!plan?.available||!bundle?.available||currentCost!==action.cost.monthlyEstimate)throw new Error('تعرفه یا دسترسی پلن تغییر کرده است؛ پیشنهاد هزینه و تأیید جدید لازم است.');
      await adapter.create(p);store.put('service',{id:action.target,name:action.target,mode:'live',platform:'node',domain:`${action.target}.liara.run`,state:'created',provider:'Liara'});jobStep(job,'لیارا ساخت سرویس را تأیید کرد');job.status='succeeded';job.message='سرویس ساخته شد؛ اکنون منبع را روی آن منتشر کنید.';
    }else if(action.type==='deploy'){
      const source=readFileSync(join(data,'sources',`${p.sourceId}.tar.gz`));if(digest(source)!==p.sha256)throw new Error('اثر انگشت منبع تغییر کرده؛ انتشار متوقف شد.');
      jobStep(job,'اثر انگشت بستهٔ تأییدشده معتبر است');
      const release=await adapter.deploy(action.target,source,p.platform,p.port,title=>jobStep(job,title));job.releaseId=release.releaseID;if(!job.releaseId)throw new Error('لیارا شناسهٔ انتشار برنگرداند؛ وضعیت پنل را بررسی کنید.');jobStep(job,'انتشار در لیارا ثبت شد');
      let ready=false;for(let n=0;n<120;n++){const r=await adapter.release(job.releaseId);const state=r.release?.state;if(['FAILED','UNHEALTHY'].includes(state))throw new Error(`انتشار لیارا ${state} است؛ لاگ را بررسی کنید.`);if(state==='READY'){ready=true;break;}await new Promise(r=>setTimeout(r,5000));}
      if(!ready)throw new Error('زمان انتظار انتشار تمام شد؛ پیش از تلاش مجدد وضعیت لیارا را بررسی کنید.');jobStep(job,'نسخهٔ لیارا به وضعیت READY رسید');
    }
    if(action.type!=='create-app'){
      const healthy=await verifyService(action.target,3,action.mode);jobStep(job,'سه بررسی HTTP پس از عملیات',healthy?'done':'failed');job.status=healthy?'succeeded':'needs_attention';job.message=healthy?'عملیات انجام شد و هر سه بررسی سلامت موفق بودند.':'عملیات ارسال شد، اما سلامت HTTP تأیید نشد؛ بررسی بیشتر لازم است.';
      if(healthy)for(const incident of store.list('incident').filter(i=>i.target===action.target&&i.status==='open'&&i.mode===action.mode)){store.put('incident',{...incident,status:'resolved',resolved:new Date().toISOString(),resolution:job.message,jobId:job.id});}
    }
    store.put('job',job);store.db.prepare("UPDATE approvals SET status='completed' WHERE id=?").run(action.id);metrics.operations.inc({type:action.type,result:job.status});store.audit('operation.finished',{id:job.id,target:action.target,status:job.status});
  }catch(error){job.status='failed';job.message=safe(error.message);store.put('job',job);store.db.prepare("UPDATE approvals SET status='failed' WHERE id=?").run(action.id);metrics.operations.inc({type:action.type,result:'failed'});store.audit('operation.failed',{id:job.id,target:action.target,message:job.message});}
}

app.post('/api/incidents',api(async(req,res)=>{
  const {target,message}=z.object({target:idSchema,message:z.string().max(2000).default('بررسی سلامت سرویس')}).parse(req.body);
  const service=store.get('service',target,mode);if(!service||service.mode!==mode)throw new Error('سرویس این محیط پیدا نشد.');
  const atMode=mode,logs=(mode==='demo'?demoLogs:await liara.logs(target)).map(x=>({...x,line:safe(x.line)}));
  const latest=await probe(target),hypotheses=diagnose(logs,latest);
  const incident=store.put('incident',{mode:atMode,target,title:latest?.ok?'بررسی وضعیت سرویس':'اختلال در پاسخ‌گویی سرویس',status:latest?.ok?'observed':'open',severity:latest?.ok?'info':'warning',message:safe(message),logs:logs.slice(-15),probe:latest,hypotheses,engine:'rules',advice:null,limitation:'این بررسی بر اساس لاگ و HTTP است؛ متریک CPU/RAM اپ لیارا در این نسخه متصل نیست.'});
  try{const advice=await llmAdvice(config,{message:incident.message,logs:incident.logs,probe:latest,hypotheses});if(advice){incident.advice=safe(advice);incident.engine='llm';}}catch(e){incident.modelError=safe(e.message);}
  store.put('incident',incident);metrics.incidents.inc({mode:atMode});store.audit('incident.investigated',{id:incident.id,target,engine:incident.engine});res.json(incident);
}));
app.post('/api/demo/fault',(req,res)=>{requireMode('demo');demoFault=z.enum(['error','slow']).parse(req.body.type);store.audit('sandbox.fault_injected',{type:demoFault});res.json({ok:true});});
app.get('/api/incidents/:id/report',(req,res)=>{
  const i=store.get('incident',req.params.id);if(!i||i.mode!==mode)return res.status(404).end();
  const report=`# گزارش رخداد راه‌بان\n\n- سرویس: ${i.target}\n- محیط: ${i.mode}\n- زمان: ${i.created}\n- وضعیت: ${i.status}\n- موتور: ${i.engine}\n\n## شواهد\nHTTP: ${i.probe?.code??'unknown'}\n\n${i.hypotheses.map(h=>`### ${h.title}\n${h.evidence}\n\n${h.next}`).join('\n\n')}\n\n## تحلیل مدل\n${i.advice||'مدل متصل نیست؛ تحلیل مبتنی بر قواعد است.'}\n\n## بازیابی\n${i.resolution||'بازیابی هنوز تأیید نشده است.'}\n\n## محدودیت\n${i.limitation}\n\n## پیگیری پیشنهادی\n- افزودن تست پیکربندی پیش از انتشار\n- مرور هشدار و شرط سلامت\n`;
  res.set('Content-Type','text/markdown; charset=utf-8').set('Content-Disposition',`attachment; filename="incident-${i.id}.md"`).send(report);
});

// Actual local sandbox response is probed over HTTP; no fabricated historic metrics.
app.get('/sandbox',async(req,res)=>{
  if(demoFault==='slow')await new Promise(r=>setTimeout(r,1600));
  const failed=demoFault==='error';const line=failed?'ERROR DEMO_CONFIG_INVALID: required environment configuration missing':'INFO GET /sandbox 200';
  demoLogs.push({at:Date.now(),line});if(demoLogs.length>150)demoLogs.shift();
  res.status(failed?503:200).type('html').send('<html lang="fa" dir="rtl"><title>Rahban Sandbox</title><body style="background:#0d1219;color:#c2ee92;padding:10vw;font:24px sans-serif"><h1>'+(failed?'اختلال آزمایشی فعال است':'سرویس آزمایشی سالم است')+'</h1><p>این محیط مستقل از پروژه‌های لیارای شماست.</p></body></html>');
});
async function probe(id,environment=mode){
  const service=store.get('service',id,environment);if(!service)return null;
  const url=service.mode==='demo'?`http://127.0.0.1:${process.env.PORT||4310}/sandbox`:(/^[a-z0-9-]+\.liara\.run$/.test(service.domain||'')?`https://${service.domain}`:null);
  if(!url)return null;const start=performance.now();let code=0;
  try{const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(6000)});code=r.status;await r.body?.cancel();}catch{}
  const ms=performance.now()-start,ok=code>=200&&code<400&&ms<1500;const row={service:id,at:Date.now(),ok:ok?1:0,ms,code};
  store.db.prepare('INSERT INTO probes(service,at,ok,ms,code,mode) VALUES(?,?,?,?,?,?)').run(id,row.at,row.ok,ms,code,environment);
  const label=environment+'/'+id;metrics.probes.inc({service:label,result:ok?'success':'failure'});metrics.latency.observe({service:label},ms/1000);metrics.up.set({service:label},ok?1:0);metrics.timestamp.set({service:label},Date.now()/1000);return row;
}
app.post('/api/probe/:id',api(async(req,res)=>{const service=store.get('service',req.params.id,mode);if(!service||service.mode!==mode)throw new Error('سرویس پیدا نشد.');res.json(await probe(service.id));}));
app.post('/api/jobs/:id/verify',api(async(req,res)=>{
  const job=store.get('job',req.params.id);
  if(!job||job.mode!==mode||job.status!=='needs_attention')throw new Error('این عملیات منتظر بررسی مجدد نیست.');
  if(job.releaseId){const release=await liara.release(job.releaseId);if(release.release?.state!=='READY')throw new Error('نسخهٔ لیارا هنوز READY نیست؛ ابتدا وضعیت انتشار را بررسی کنید.');}
  const healthy=await verifyService(job.target,3,job.mode);jobStep(job,'بررسی مجدد پس از گرم‌شدن سرویس: سه پاسخ متوالی',healthy?'done':'failed');
  job.status=healthy?'succeeded':'needs_attention';job.message=healthy?'انتشار انجام شده و پس از زمان گرم‌شدن، سه بررسی سلامت متوالی موفق شدند.':'سلامت سرویس هنوز تأیید نشده است.';
  store.put('job',job);store.audit('operation.health_verified',{id:job.id,target:job.target,healthy});
  if(healthy)for(const i of store.list('incident').filter(i=>i.mode===job.mode&&i.target===job.target&&i.status==='open'))store.put('incident',{...i,status:'resolved',resolved:new Date().toISOString(),resolution:job.message,jobId:job.id});
  res.json(job);
}));
app.get('/metrics',api(async(req,res)=>{metrics.pending.set(approvals().filter(a=>a.status==='pending').length);res.type(metrics.registry.contentType).send(await metrics.registry.metrics());}));
app.get('/healthz',(req,res)=>res.json({status:'ok',service:'rahban',time:new Date().toISOString()}));
app.use(express.static(join(root,'dist')));
app.get('/{*path}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'مسیر API پیدا نشد.'});if(existsSync(join(root,'dist/index.html')))return res.sendFile(join(root,'dist/index.html'));res.status(503).send('Run npm run build first.');});
app.use((error,req,res,next)=>{res.status(error instanceof z.ZodError?400:400).json({error:error instanceof z.ZodError?'ورودی معتبر نیست؛ فیلدها را بررسی کنید.':safe(error.message||'خطای نامشخص')});});
store.put('service',{id:'sandbox-store',name:'فروشگاه آزمایشی',mode:'demo',platform:'Node.js 22',provider:'Local sandbox',domain:null,state:'running'});
const port=Number(process.env.PORT||hosting.port||4310);app.listen(port,process.env.HOST||hosting.host||'127.0.0.1',()=>{console.log(`Rahban listening on port ${port}`);probe('sandbox-store','demo');});
setInterval(async()=>{if(probeBusy)return;probeBusy=true;try{
  const targets=store.list('service').filter(s=>s.mode===mode).slice(0,10);
  await Promise.allSettled(targets.map(async s=>{
    await probe(s.id,s.mode);
    const recent=store.db.prepare('SELECT ok,ms,code,at FROM probes WHERE service=? AND mode=? ORDER BY at DESC LIMIT 3').all(s.id,s.mode);
    if(recent.length===3&&recent.every(p=>p.ok)){
      for(const i of store.list('incident').filter(i=>i.mode===s.mode&&i.target===s.id&&i.status==='open')){
        store.put('incident',{...i,status:'resolved',resolved:new Date().toISOString(),resolution:'سه بررسی متوالی سالم ثبت شد. بازیابی پاسخ HTTP مشاهده شد؛ اقدام اصلاحی توسط ناظر اجرا نشده است.'});
        store.audit('incident.recovered',{id:i.id,target:s.id});
      }
      return;
    }
    if(recent.length!==3||recent.some(p=>p.ok))return;
    if(store.list('incident').some(i=>i.target===s.id&&i.status==='open'))return;
    // Agent wakes only after sustained probe failure; continuous polling is inexpensive HTTP, not LLM inference.
    const raw=s.mode==='demo'?demoLogs:await liara.logs(s.id);
    const logs=raw.slice(-15).map(l=>({...l,line:safe(l.line)}));
    const incident=store.put('incident',{mode:s.mode,target:s.id,title:'اختلال پایدار در بررسی سلامت',status:'open',severity:'warning',message:'سه بررسی متوالی ناموفق؛ بررسی خودکار مبتنی بر قواعد فعال شد.',logs,probe:recent[0],hypotheses:diagnose(logs,recent[0]),engine:'rules',trigger:'three-failed-probes',limitation:'پایش مبتنی بر HTTP است؛ CPU و RAM اپ لیارا متصل نیست.'});
    metrics.incidents.inc({mode:s.mode});store.audit('incident.investigated',{id:incident.id,target:s.id,engine:'rules',trigger:'monitor'});
  }));
  store.db.prepare('DELETE FROM probes WHERE at<?').run(Date.now()-86400000);
}finally{probeBusy=false;}},5000).unref();
