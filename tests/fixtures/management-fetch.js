import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';

// Imported only by an isolated test child. Every cloud request is intercepted.
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
  const url=new URL(input),state=JSON.parse(readFileSync(process.env.TEST_MANAGEMENT_STATE,'utf8'));
  const save=()=>writeFileSync(process.env.TEST_MANAGEMENT_STATE,JSON.stringify(state));
  const record=value=>appendFileSync(process.env.TEST_MANAGEMENT_CALLS,JSON.stringify(value)+'\n');
  if(url.origin==='https://api.liara.ir'){
    const method=init.method||'GET',body=typeof init.body==='string'?JSON.parse(init.body):null;
    record({path:url.pathname,method,body,team:url.searchParams.get('teamID')});
    if(method==='GET'&&url.pathname==='/v1/projects')return Response.json({projects:state.exists?[{project_id:'management-test',name:'management-test',type:'docker',status:state.scale===0?'STOPPED':'RUNNING'}]:[]});
    if(method==='GET'&&url.pathname==='/v1/projects/management-test')return state.exists?Response.json({project:{type:'docker',status:state.scale===0?'STOPPED':'RUNNING',state:state.scale===0?'STOPPED':'RUNNING',scale:state.scale,envs:state.envs,disks:[]}}):Response.json({},{status:404});
    if(method==='POST'&&url.pathname==='/v1/projects/update-envs'){
      if(body.project!=='management-test'||!state.exists)throw new Error('Unexpected environment update target');
      state.envs=body.variables;save();return Response.json({});
    }
    if(method==='POST'&&url.pathname==='/v1/projects/management-test/actions/scale'){
      if(![0,1].includes(body.scale))throw new Error('Invalid fixture scale');
      state.scale=body.scale;save();return Response.json({});
    }
    if(method==='DELETE'&&url.pathname==='/v1/projects/management-test'){
      state.exists=false;save();return state.deleteUncertain?Response.json({},{status:503}):Response.json({});
    }
    throw new Error('Unexpected management fixture cloud request: '+method+' '+url.pathname);
  }
  if(url.hostname==='management-test.liara.run'){
    record({probe:url.pathname});return new Response(state.exists&&state.scale!==0?'healthy':'stopped',{status:state.exists&&state.scale!==0?200:503});
  }
  if(url.hostname!=='127.0.0.1')throw new Error('Unexpected external request in management fixture');
  return originalFetch(input,init);
};
