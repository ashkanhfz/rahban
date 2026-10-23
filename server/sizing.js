// Conservative starting assumptions, not load-test results or capacity guarantees.
export function recommendPlan(plans,sizing={minMemoryGB:.5,minCpu:.25},budget=Infinity){
  const candidates=[];
  for(const [planID,p]of Object.entries(plans.projects||{})){
    const memory=Number(p.RAM?.amount),cpu=Number(p.CPU?.amount);
    if(!Number.isFinite(memory)||!Number.isFinite(cpu)||!p.available||(p.region&&p.region!=='iran')||memory<sizing.minMemoryGB||cpu<sizing.minCpu)continue;
    for(const [bundlePlanID,b]of Object.entries(plans.projectBundlePlans?.[planID]||{})){
      const cost=Number(p.price)*720+Number(b.displayPrice||0);
      if(!b.available||!Number.isFinite(cost)||cost>budget)continue;
      candidates.push({planID,bundlePlanID,monthlyEstimate:cost,memoryGB:Number(p.RAM.amount),cpu:Number(p.CPU.amount)});
    }
  }
  candidates.sort((a,b)=>a.monthlyEstimate-b.monthlyEstimate||a.memoryGB-b.memoryGB);
  return candidates.length?{...candidates[0],reason:`The lowest-cost available option with at least ${sizing.minMemoryGB}GB of memory and ${sizing.minCpu} CPU cores, based on initial project assumptions. This is not a capacity guarantee; measure actual usage after deployment.`}:null;
}
