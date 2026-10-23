import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {resolveGitHubSource} from './github.js';

const inputSchema=z.object({enabled:z.boolean(),intervalMinutes:z.union([z.literal(1),z.literal(5),z.literal(15),z.literal(60)]).default(5),mode:z.enum(['review','automatic']).default('review'),confirmation:z.string().max(100).optional()});
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const sha=/^[a-f0-9]{40}$/i;
const sameSettings=(a,b)=>JSON.stringify(Object.entries(a||{}).sort())===JSON.stringify(Object.entries(b||{}).sort());

// Poll only while this process holds the current explicit authorization. A restart
// preserves the configuration, but requires the operator to enable it again.
export function installContinuous(app,{store,api,getMode,getScope,getContext,connected,safe,prepare,execute,resolveSource=resolveGitHubSource,now=()=>Date.now(),intervalMs=15000}){
  const busy=new Set();let stopped=false,ticking=false;
  const schedules=()=>store.list('continuous');
  const current=target=>schedules().find(row=>row.target===target&&row.accountScope===getScope());
  const approval=id=>store.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
  const rejectPending=id=>{if(id)store.db.prepare("UPDATE approvals SET status='rejected' WHERE id=? AND status='pending'").run(id);};
  const update=(row,change)=>store.put('continuous',{...row,...change});
  const pause=(row,message)=>update(row,{enabled:false,status:'paused',nextRun:null,lastError:safe(message)});
  function service(target){
    if(getMode()!=='live'||!connected())throw fail('CONTINUOUS_CONNECTION_REQUIRED','Connect to Liara first.');
    const row=store.get('service',target,'live');
    if(!row||row.accountScope!==getScope())throw fail('CONTINUOUS_SERVICE_MISSING','Refresh the app in this Liara account first.',404);
    return row;
  }
  function eligibility(row){
    if(!row.github?.repo||!row.github?.branch||!sha.test(row.github.commit||''))return 'First complete a deployment imported from a public GitHub repository.';
    const job=row.lastJobId?store.get('job',row.lastJobId):null;
    if(!job||job.type!=='deploy'||job.status!=='succeeded'||job.target!==row.id||job.accountScope!==getScope()||job.commit!==row.github.commit)return 'A successful, verified GitHub deployment is required before enabling updates.';
    return null;
  }
  const defaults=row=>({target:row.id,enabled:false,intervalMinutes:5,mode:'review',status:'disabled',github:row.github?{repo:row.github.repo,branch:row.github.branch}:null,settings:row.settings||{},pendingApprovalId:null,pendingCommit:null,lastJobId:null,latestCommit:row.github?.commit||null,lastChecked:null,nextRun:null,lastError:null});
  function view(row,appRow){
    const {accountScope,approvalContext,revision,id,created,authorizedAt,...publicRow}=row||defaults(appRow);
    const unavailableReason=eligibility(appRow);return {...publicRow,eligible:!unavailableReason,unavailableReason};
  }
  const jobsFor=target=>store.db.prepare("SELECT body FROM records WHERE kind='job' AND json_extract(body,'$.target')=? AND json_extract(body,'$.mode')='live' AND json_extract(body,'$.accountScope')=? ORDER BY created DESC").all(target,getScope()).map(row=>JSON.parse(row.body)).filter(job=>job.type!=='check');
  function blocked(target,except){return jobsFor(target).find(job=>job.id!==except&&['running','needs_attention','interrupted'].includes(job.status));}
  function active(row){
    const latest=store.get('continuous',row.id);
    if(stopped||getMode()!=='live'||!connected()||getScope()!==row.accountScope||getContext()!==row.approvalContext||!latest?.enabled||latest.revision!==row.revision)throw fail('CONTINUOUS_AUTHORIZATION_CHANGED','The connection or schedule changed. Review and enable updates again.');
    const appRow=service(row.target);
    if(appRow.github?.repo!==row.github.repo||appRow.github?.branch!==row.github.branch||!sameSettings(appRow.settings,row.settings))throw fail('CONTINUOUS_SOURCE_CHANGED','The deployed repository, branch or settings changed. Review and enable updates again.');
    return appRow;
  }
  for(const row of schedules().filter(row=>row.enabled))pause(row,'Rahban restarted. Review and enable GitHub updates again.');

  async function check(target){
    const appRow=service(target),row=current(target);
    if(!row?.enabled)throw fail('CONTINUOUS_DISABLED','Enable GitHub updates before checking.');
    const key=row.accountScope+':'+target;
    if(busy.has(key))throw fail('CONTINUOUS_BUSY','A GitHub update check is already running.');
    busy.add(key);let preparedId;
    try{
      let deployed=active(row);const baselineCommit=deployed.github?.commit;
      if(row.pendingApprovalId){
        const job=jobsFor(target).find(job=>job.approvalId===row.pendingApprovalId),pending=approval(row.pendingApprovalId);
        if(job){
          if(job.status==='running')return view(update(row,{status:'deploying',lastJobId:job.id}),deployed);
          if(job.status!=='succeeded')throw fail('CONTINUOUS_DEPLOYMENT_STOPPED','The scheduled deployment failed or needs verification. Resolve it, then enable updates again.');
          if(deployed.github?.commit!==row.pendingCommit)throw fail('CONTINUOUS_COMMIT_CHANGED','The completed deployment does not match the expected commit. Review the app before enabling updates again.');
          const next=update(row,{pendingApprovalId:null,pendingCommit:null,lastJobId:job.id,latestCommit:row.pendingCommit,status:'scheduled',nextRun:now()+row.intervalMinutes*60000,lastError:null});
          return view(next,deployed);
        }
        if(pending?.status==='pending'&&pending.context===row.approvalContext&&pending.expires>now())return view(update(row,{status:'awaiting_approval'}),deployed);
        throw fail('CONTINUOUS_APPROVAL_STOPPED','The update approval expired, was rejected, or cannot be verified. Review and enable updates again.');
      }
      if(blocked(target))throw fail('CONTINUOUS_OPERATION_PENDING','Another cloud operation is running or needs verification. Resolve it, then enable updates again.');
      update(row,{status:'checking',lastChecked:now(),nextRun:now()+row.intervalMinutes*60000,lastError:null});
      const github=await resolveSource(row.github.repo,row.github.branch);
      deployed=active(row);
      if(deployed.github?.commit!==baselineCommit)throw fail('CONTINUOUS_DEPLOYMENT_CHANGED','Another deployment changed the app during this check. Review and enable updates again.');
      if(github.repo!==row.github.repo||github.branch!==row.github.branch||!sha.test(github.commit||''))throw fail('CONTINUOUS_INVALID_SOURCE','GitHub returned a different repository, branch or invalid commit.');
      if(blocked(target))throw fail('CONTINUOUS_OPERATION_PENDING','Another cloud operation started during this check. Review it before enabling updates again.');
      if(github.commit===deployed.github.commit)return view(update(row,{status:'scheduled',lastChecked:now(),latestCommit:github.commit,nextRun:now()+row.intervalMinutes*60000,lastError:null}),deployed);
      const proposed=await prepare(target,github,row.settings);preparedId=proposed?.id;
      if(!preparedId)throw fail('CONTINUOUS_APPROVAL_MISSING','No deployment approval was returned.');
      deployed=active(row);
      if(deployed.github?.commit!==baselineCommit)throw fail('CONTINUOUS_DEPLOYMENT_CHANGED','Another deployment changed the app while preparing approval. Review and enable updates again.');
      const saved=approval(preparedId);
      if(!saved||saved.status!=='pending'||saved.context!==row.approvalContext||saved.expires<=now())throw fail('CONTINUOUS_APPROVAL_CHANGED','The prepared approval is no longer valid. Review and enable updates again.');
      const action=JSON.parse(saved.body),approvedSource=action.payload?.github||(action.payload?.sourceId?store.get('source',action.payload.sourceId)?.github:null);
      if(action.type!=='deploy'||action.mode!=='live'||action.target!==target||!sameSettings(action.payload?.settings,row.settings)||approvedSource?.repo!==github.repo||approvedSource?.branch!==github.branch||approvedSource?.commit!==github.commit)throw fail('CONTINUOUS_APPROVAL_MISMATCH','The prepared approval differs from the authorized app, source or settings.');
      if(blocked(target))throw fail('CONTINUOUS_OPERATION_PENDING','Another cloud operation started before approval. Review it before enabling updates again.');
      const pending=update(row,{pendingApprovalId:preparedId,pendingCommit:github.commit,latestCommit:github.commit,lastChecked:now(),nextRun:null,lastError:null,status:'awaiting_approval'});
      store.audit('continuous.prepared',{target,commit:github.commit,approvalId:preparedId,mode:row.mode});
      if(row.mode==='review'){preparedId=null;return view(pending,deployed);}
      active(pending);
      const job=await execute(preparedId,target);
      if(!job?.id)throw fail('CONTINUOUS_JOB_MISSING','Deployment submission was not confirmed. Check operations before enabling updates again.');
      // Persist the submitted job even if the operator disabled polling meanwhile;
      // this records the one approved mutation without restoring authorization.
      const latest=store.get('continuous',row.id);
      const next=latest?.revision===row.revision?update(latest,{lastJobId:job.id,status:latest.enabled?'deploying':latest.status}):latest;
      preparedId=null;return view(next||pending,deployed);
    }catch(error){
      if(preparedId)rejectPending(preparedId);
      const latest=store.get('continuous',row.id);
      const result=latest?.revision===row.revision?pause(latest,error.message):latest;
      store.audit('continuous.paused',{target,reason:safe(error.message)});
      return view(result||row,appRow);
    }finally{busy.delete(key);}
  }
  app.get('/api/services/:id/continuous',api(async(req,res)=>{const row=service(req.params.id);res.json(view(current(row.id),row));}));
  app.post('/api/services/:id/continuous',api(async(req,res)=>{
    const row=service(req.params.id),input=inputSchema.parse(req.body),old=current(row.id);
    if(input.enabled){
      const reason=eligibility(row);if(reason)throw fail('CONTINUOUS_INELIGIBLE',reason);
      if(blocked(row.id))throw fail('CONTINUOUS_OPERATION_PENDING','Resolve running or uncertain cloud operations before enabling updates.');
      if(input.mode==='automatic'&&input.confirmation!==row.id)throw fail('CONTINUOUS_CONFIRMATION_REQUIRED','Enter the exact app name to authorize automatic deployments.');
    }
    if(old?.pendingApprovalId)rejectPending(old.pendingApprovalId);
    const saved=store.put('continuous',{...defaults(row),id:old?.id||randomUUID(),target:row.id,accountScope:getScope(),approvalContext:getContext(),revision:randomUUID(),github:row.github?{repo:row.github.repo,branch:row.github.branch}:null,settings:structuredClone(row.settings||{}),enabled:input.enabled,intervalMinutes:input.intervalMinutes,mode:input.mode,status:input.enabled?'scheduled':'disabled',nextRun:input.enabled?now()+input.intervalMinutes*60000:null,authorizedAt:input.enabled&&input.mode==='automatic'?now():null});
    store.audit('continuous.updated',{target:row.id,enabled:input.enabled,mode:input.mode,intervalMinutes:input.intervalMinutes,automaticAuthorized:!!saved.authorizedAt});
    res.json(view(saved,row));
  }));
  app.post('/api/services/:id/continuous/check',api(async(req,res)=>res.json(await check(req.params.id))));
  async function tick(){
    if(stopped||ticking||getMode()!=='live'||!connected())return;
    ticking=true;
    try{
      const scope=getScope();
      for(const row of schedules().filter(row=>row.enabled&&row.accountScope===scope&&(row.pendingApprovalId||row.nextRun<=now()))){
        if(stopped||getMode()!=='live'||getScope()!==scope)break;
        if(busy.has(scope+':'+row.target))continue;
        try{await check(row.target);}catch(error){const latest=store.get('continuous',row.id);if(latest?.revision===row.revision)pause(latest,error.message);}
      }
    }finally{ticking=false;}
  }
  const timer=setInterval(()=>{tick().catch(()=>{});},intervalMs);timer.unref();
  return {tick,check,stop:()=>{stopped=true;clearInterval(timer);}};
}
