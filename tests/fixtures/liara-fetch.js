import {appendFileSync} from 'node:fs';

// Child-process fixture: production code keeps its pinned Liara origin.
const originalFetch=globalThis.fetch;
let releaseChecks=0;
globalThis.fetch=async(input,init={})=>{
  const url=new URL(input);
  if(url.origin==='https://api.liara.ir'){
    const body=typeof init.body==='string'?JSON.parse(init.body):null;
    appendFileSync(process.env.TEST_LIARA_CALLS,JSON.stringify({path:url.pathname,method:init.method||'GET',body})+'\n');
    let value;
    if(url.pathname==='/v1/me')value={plans:{projects:{small:{available:true,price:1}},projectBundlePlans:{small:{basic:{available:true,displayPrice:0}}}}};
    else if(url.pathname==='/v1/projects/')value={};
    else if(url.pathname.endsWith('/sources'))value={sourceID:'source-test'};
    else if(url.pathname.endsWith('/releases'))value={releaseID:'release-test'};
    else if(url.pathname==='/v1/releases/release-test'){
      if(process.env.TEST_RELEASE_FAIL_ONCE==='1'&&releaseChecks++===0)return Response.json({},{status:503});
      value={release:{state:'READY'}};
    }
    else if(url.pathname==='/v1/projects/deploy-test')value={project:{envs:[],disks:[]}};
    else throw new Error('Unexpected Liara request: '+url.pathname);
    return Response.json(value);
  }
  if(url.hostname==='deploy-test.liara.run'){
    appendFileSync(process.env.TEST_LIARA_CALLS,JSON.stringify({probe:url.pathname})+'\n');
    return new Response('healthy',{status:url.pathname==='/healthz'?200:404});
  }
  if(url.hostname!=='127.0.0.1')throw new Error('Unexpected external request in test');
  return originalFetch(input,init);
};
