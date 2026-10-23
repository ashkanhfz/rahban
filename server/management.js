const removableTypes=new Set(['deploy','create-app','check','restart','update-env','delete-app','start-app','stop-app']);
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});

// Local history is hidden, never deleted: approvals and scheduler evidence keep their references.
export function installManagement(app,{store,api,getMode,getScope,connected,getAdapter,safe}){
  app.delete('/api/jobs/:id',api(async(req,res)=>{
    const job=store.get('job',req.params.id),mode=getMode(),scope=getScope();
    if(!job||job.mode!==mode||mode==='live'&&job.accountScope!==scope)throw fail(404,'JOB_NOT_FOUND','Operation not found in this account and environment.');
    if(!removableTypes.has(job.type))throw fail(409,'HISTORY_REMOVAL_UNSUPPORTED','This record cannot be removed from history.');
    if(!['succeeded','failed'].includes(job.status)||job.type==='deploy'&&job.status==='failed'&&(job.releaseRequested||job.releaseId)&&!job.releaseFailed)throw fail(409,'HISTORY_REQUIRES_VERIFICATION','Wait for the operation to finish, or verify its outcome before removing it from history.');
    if(!job.hidden){
      store.put('job',{...job,hidden:true});
      store.audit('history.removed',{id:job.id,target:job.target,type:job.type,mode,accountScope:scope});
    }
    res.json({ok:true});
  }));

  app.get('/api/services/:id/configuration',api(async(req,res)=>{
    if(getMode()!=='live'||!connected())throw fail(409,'LIARA_CONNECTION_REQUIRED','Connect to Liara to read app configuration.');
    const scope=getScope(),row=store.get('service',req.params.id,'live');
    if(!row||row.accountScope!==scope)throw fail(404,'SERVICE_NOT_FOUND','Refresh the apps for this account first.');
    const adapter=getAdapter(); // Capture credentials before the first asynchronous operation.
    const assertCurrent=()=>{
      const current=store.get('service',row.id,'live');
      if(getMode()!=='live'||!connected()||getScope()!==scope||current?.accountScope!==scope)throw fail(409,'CONFIGURATION_CONTEXT_CHANGED','The connection or app changed. Refresh app configuration.');
    };
    let details;
    try{details=await adapter.details(row.id);}
    catch(error){
      assertCurrent();
      // Do not forward provider response bodies: they may contain environment values.
      throw fail(Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:502,'CONFIGURATION_UNAVAILABLE','Liara could not provide app configuration. Refresh the connection and try again.');
    }
    assertCurrent();
    if(!details||!Array.isArray(details.envs)||details.envs.some(env=>typeof (env?.key||env?.name)!=='string'))throw fail(502,'LIARA_INVALID_RESPONSE','Liara returned incomplete app configuration. Refresh before changing the app.');
    // Disk metadata is optional in Liara responses; missing data never means no disks.
    const result={service:{id:row.id,name:row.name||row.id},platform:typeof (details.type||details.platform)==='string'?(details.type||details.platform):row.platform||'unknown',envKeys:[...new Set(details.envs.map(env=>env.key||env.name))].sort(),hasDisks:Array.isArray(details.disks)?details.disks.length>0:null};
    res.json(JSON.parse(safe(JSON.stringify(result))));
  }));
}
