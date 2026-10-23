const number=value=>['number','string'].includes(typeof value)&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
const featureNames={maxDeploymentCountInDay:'Deployments per day',maxDomainsCount:'Custom domains',rollback:'Rollback',zeroDowntime:'Zero downtime',freeSSL:'Free SSL'};

// Preserve unknown prices as unknown; never infer a free bundle or a capacity guarantee.
export function planCatalog(plans={}){
  return Object.entries(plans.projects||{}).filter(([,p])=>p.available&&(!p.region||p.region==='iran')).map(([planID,p])=>{
    const hourly=number(p.price),monthlyBase=hourly===null?null:number(hourly*720);
    const bundles=Object.entries(plans.projectBundlePlans?.[planID]||{}).filter(([,b])=>b.available).map(([bundlePlanID,b])=>({
      bundlePlanID,monthlyPrice:number(b.displayPrice),
      features:Object.entries(featureNames).filter(([key])=>Object.hasOwn(b,key)&&['string','number','boolean'].includes(typeof b[key])).map(([key,name])=>({name,value:b[key]==='infinite'?'Unlimited':b[key]})),
    }));
    const unavailableReason=monthlyBase===null?'Liara did not provide a valid resource price.':!bundles.length?'Liara returned no available feature bundles for this plan. Select another plan.':!bundles.some(b=>b.monthlyPrice!==null)?'Liara did not provide a valid price for the available feature bundles.':null;
    return {planID,memoryGB:number(p.RAM?.amount),cpu:number(p.CPU?.amount),cpuShared:typeof p.CPU?.shared==='boolean'?p.CPU.shared:null,diskGB:number(p.volume),monthlyBase,bundles,selectable:!unavailableReason,unavailableReason};
  });
}

export function recommendPlan(plans,sizing={minMemoryGB:.5,minCpu:.25},budget=Infinity){
  const candidates=[];
  for(const p of planCatalog(plans)){
    if(!p.selectable||p.memoryGB===null||p.cpu===null||p.memoryGB<sizing.minMemoryGB||p.cpu<sizing.minCpu)continue;
    for(const b of p.bundles){
      if(b.monthlyPrice===null)continue;
      const cost=p.monthlyBase+b.monthlyPrice;
      if(!Number.isFinite(cost)||cost>budget)continue;
      candidates.push({planID:p.planID,bundlePlanID:b.bundlePlanID,monthlyEstimate:cost,memoryGB:p.memoryGB,cpu:p.cpu});
    }
  }
  candidates.sort((a,b)=>a.monthlyEstimate-b.monthlyEstimate||a.memoryGB-b.memoryGB);
  const basis=sizing.basis||'Generic trial minimum; no runtime measurements or load test are available.';
  return candidates.length?{...candidates[0],basis,reason:`Lowest estimated monthly cost among the available plans with at least ${sizing.minMemoryGB} GB RAM and ${sizing.minCpu} CPU cores. ${basis} This is a starting point, not a capacity guarantee. Estimate: 720 hours plus the selected feature bundle.`}:null;
}
