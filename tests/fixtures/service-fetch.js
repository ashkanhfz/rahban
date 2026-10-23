import {appendFileSync} from 'node:fs';

// Only the isolated test child imports this fixture; no external request escapes.
const originalFetch=globalThis.fetch;
const ownedDomain={_id:'domain-owned',name:'example.test',project:{project_id:'service-test'},status:'pending',certificatesStatus:'pending',CNameRecord:'service-test.liara.run'};
let metricsCalls=0;
const record=value=>appendFileSync(process.env.TEST_SERVICE_CALLS,JSON.stringify(value)+'\n');
globalThis.fetch=async(input,init={})=>{
  const url=new URL(input);
  if(url.origin==='https://api.liara.ir'){
    const method=init.method||'GET';record({path:url.pathname,method,team:url.searchParams.get('teamID')});
    if(method!=='GET')throw new Error('Unexpected cloud mutation in service workflow test');
    if(url.pathname==='/v1/projects')return Response.json({projects:[{project_id:'service-test',name:'service-test',type:'docker',status:'RUNNING'}]});
    if(url.pathname==='/v1/projects/service-test')return Response.json({project:{status:'RUNNING',type:'docker',envs:[{key:'PRIVATE',value:'details-secret'}],disks:[]}});
    if(url.pathname==='/v2/projects/service-test/logs')return Response.json({data:[{values:[['123','Missing DATABASE_URL; credential workflow-test-token'],['124','ECONNREFUSED database']]}]});
    if(url.pathname==='/v1/projects/service-test/metrics/summary')return metricsCalls++===0?Response.json({message:'metrics-provider-secret'},{status:403}):Response.json({cpuUsage:[{applet:'one',value:[123,'0.35']}],memoryUsage:[]});
    if(url.pathname==='/v1/domains'){
      if(url.searchParams.get('project')!=='service-test')throw new Error('Wrong domain project');
      return Response.json({domains:[ownedDomain,{_id:'domain-other',name:'other.test',project:{project_id:'another-app'}}]});
    }
    if(url.pathname==='/v1/domains/domain-owned/check')return Response.json({domain:{...ownedDomain,status:'verified',certificatesStatus:'issued'}});
    throw new Error('Unexpected Liara request: '+url.pathname);
  }
  if(url.hostname==='service-test.liara.run'){record({probe:url.pathname});return new Response('Application configuration error',{status:500});}
  if(url.hostname!=='127.0.0.1')throw new Error('Unexpected external request in service workflow test');
  return originalFetch(input,init);
};
