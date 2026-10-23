const scalar=value=>['string','number','boolean'].includes(typeof value);
const finite=value=>['string','number'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value));
function unavailable(label,error){
  const status=Number.isInteger(error?.status)?` (HTTP ${error.status})`:'';
  return `${label} are unavailable${status}. Other evidence may still be useful.`;
}
function metric(rows,reason){
  const samples=(Array.isArray(rows)?rows:[]).slice(-100).flatMap(row=>{
    if(!Array.isArray(row?.value)||!finite(row.value[0])||!finite(row.value[1]))return [];
    return [{applet:typeof row.applet==='string'?row.applet.slice(0,150):null,at:Number(row.value[0]),value:Number(row.value[1])}];
  });
  return samples.length?{status:'available',samples,unit:null}:{status:'unavailable',samples:[],unit:null,reason:reason||'Liara returned no numeric samples.'};
}

// Fail independently: a missing metrics entitlement must not hide useful logs.
export async function collectServiceEvidence(adapter,target){
  const [detailResult,logResult,metricResult]=await Promise.allSettled([
    Promise.resolve().then(()=>adapter.details(target)),
    Promise.resolve().then(()=>adapter.logs(target)),
    Promise.resolve().then(()=>adapter.metricsSummary(target)),
  ]);
  const limitations=[],service={state:'unknown',platform:'unknown'};
  if(detailResult.status==='fulfilled'&&detailResult.value&&typeof detailResult.value==='object'){
    const details=detailResult.value;
    for(const [key,value] of Object.entries({state:details.status||details.state,platform:details.type||details.platform,planID:details.planID,isDeployed:details.isDeployed}))if(scalar(value))service[key]=value;
  }else limitations.push(unavailable('Service details',detailResult.reason));
  const logs=logResult.status==='fulfilled'&&Array.isArray(logResult.value)?logResult.value.slice(-150).filter(row=>typeof row?.line==='string').map(row=>({at:scalar(row.at)?row.at:null,line:row.line.slice(0,4000)})):[];
  if(logResult.status==='rejected'||!Array.isArray(logResult.value))limitations.push(unavailable('Logs',logResult.reason));
  const metricError=metricResult.status==='rejected'?unavailable('Resource metrics',metricResult.reason):null;
  const data=metricResult.status==='fulfilled'?metricResult.value:null;
  const metrics={cpu:metric(data?.cpuUsage,metricError),memory:metric(data?.memoryUsage,metricError)};
  if(metricError)limitations.push(metricError);
  else for(const [key,value] of Object.entries(metrics))if(value.status==='unavailable')limitations.push(`${key==='cpu'?'CPU':'Memory'}: ${value.reason}`);
  if(Object.values(metrics).some(value=>value.status==='available'))limitations.push('Liara does not document these summary metric units. Raw values cannot establish CPU saturation or memory pressure.');
  return {service,logs,metrics,limitations};
}
