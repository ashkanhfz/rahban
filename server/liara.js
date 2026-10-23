import {redact} from './agent.js';
import {setTimeout as delay} from 'node:timers/promises';
const BASE='https://api.liara.ir';
const RETRYABLE=new Set([429,500,502,503,504]);
function stage(path,method){
  if(method==='POST'&&/^\/v1\/projects\/?$/.test(path))return 'service creation';
  if(method==='DELETE'&&/^\/v1\/projects\/[^/]+$/.test(path))return 'service deletion';
  if(path==='/v1/projects/update-envs')return 'environment update';
  if(path.endsWith('/actions/scale'))return 'service state change';
  return path.endsWith('/sources')?'source upload':path.endsWith('/releases')?'release creation':path.endsWith('/actions/restart')?'service restart':'request';
}
function rejected(status,operation,value,token){
  const known={401:'Liara did not accept the API token. Reconnect in Settings with a valid token.',402:'Insufficient credit. Top up your Liara account.',403:'This account cannot perform this operation. Check the token permissions and selected team.',404:'The requested resource was not found in this account or team. Refresh the service list.',429:'Liara is limiting requests. Wait briefly before trying again.'};
  let message=known[status]||`Liara rejected ${operation}.`;
  if(status===409)message=operation==='service creation'?'This service name is already in use. Choose a different name and review creation again.':'This operation conflicts with the current service state. Refresh its status before preparing another request.';
  if(status===409&&operation==='service deletion')message='Another operation is already running on this app. Wait for it to finish, refresh the app, then review deletion again.';
  if(status===404&&operation==='service deletion')message='This app was not found in the selected account or team. Refresh the app list to check whether it was already deleted.';
  if(status===403&&value?.data?.code==='free_plan_platform')message='The free plan is unavailable for this platform. Select another plan and review its cost.';
  if(status===403&&value?.data?.code==='free_plan_count')message='This account has reached its free-service limit. Select another plan and review its cost.';
  if(status===400){
    const detail=typeof value?.message==='string'||Array.isArray(value?.message)?redact(String(value.message),[token]).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,500):'';
    message=operation==='environment update'?'Liara rejected the environment update. Check the variable names and values in the reviewed configuration.':operation==='service deletion'?'Liara rejected service deletion. Refresh the app and check pending operations in Liara.':operation==='service state change'?'Liara rejected the service state change. Refresh the app before preparing another request.':`Liara rejected the ${operation} settings. Review the name, plan and network.${detail?' '+detail:''}`;
  }
  if(status>=500)message=`Liara could not confirm the ${operation}. Check the Liara console before trying again.`;
  return Object.assign(new Error(`${message} (HTTP ${status})`),{status,code:`LIARA_HTTP_${status}`});
}
function invalidResponse(){return Object.assign(new Error('Liara returned an unexpected response. Refresh the connection; do not assume that the account has no resources.'),{code:'LIARA_INVALID_RESPONSE'});}
export class Liara {
  constructor(credentials,fetcher=fetch){this.credentials=credentials;this.fetcher=fetcher;}
  async request(path,{method='GET',json,body}={}){
    const {token,team}=this.credentials();if(!token)throw new Error('Add your Liara token in Settings first.');
    const url=new URL(path,BASE);if(team)url.searchParams.set('teamID',team);
    const readOnly=method==='GET',operation=stage(url.pathname,method);
    for(let attempt=0;attempt<(readOnly?2:1);attempt++){
      let response;
      try{response=await this.fetcher(url,{method,headers:{Authorization:`Bearer ${token}`,...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(json):body,signal:AbortSignal.timeout(30000),redirect:'error'});}
      catch{
        if(readOnly&&attempt===0){await delay(200);continue;}
        throw Object.assign(new Error(readOnly?'Cannot reach Liara. Check your connection and try again.':`Liara did not confirm the ${operation}. Check the Liara console before retrying; the operation may already have been applied.`),{code:'LIARA_NETWORK_ERROR'});
      }
      const value=await response.json().catch(()=>({}));
      if(response.ok)return value;
      if(readOnly&&attempt===0&&RETRYABLE.has(response.status)){await delay(200);continue;}
      throw rejected(response.status,operation,value,token);
    }
  }
  async apps(){const {projects}=await this.request('/v1/projects');if(!Array.isArray(projects))throw invalidResponse();return projects;}
  async networks(){const {networks}=await this.request('/v1/networks');if(!Array.isArray(networks))throw invalidResponse();return networks;}
  async plans(){const x=await this.request('/v1/me');return x.plans||{};}
  async details(id){return (await this.request(`/v1/projects/${encodeURIComponent(id)}`)).project;}
  async envs(id){
    const project=await this.details(id);
    if(!Array.isArray(project?.envs)||project.envs.some(env=>typeof env?.key!=='string'||!env.key||typeof env.value!=='string'))throw invalidResponse();
    return project.envs.map(({key,value})=>({key,value}));
  }
  // Liara replaces the complete environment and restarts the app. Approval belongs to the caller.
  async updateEnvs(id,variables){
    if(!Array.isArray(variables)||variables.some(env=>typeof env?.key!=='string'||!env.key||/[=\0]/.test(env.key)||typeof env.value!=='string'||env.value.includes('\0'))||new Set(variables.map(env=>env.key)).size!==variables.length)throw Object.assign(new Error('Provide a complete environment list with unique variable names and string values.'),{status:400,code:'LIARA_INVALID_ENVS'});
    return this.request('/v1/projects/update-envs',{method:'POST',json:{project:id,variables:variables.map(({key,value})=>({key,value}))}});
  }
  metricsSummary(id){return this.request(`/v1/projects/${encodeURIComponent(id)}/metrics/summary`);}
  async logs(id){const x=await this.request(`/v2/projects/${encodeURIComponent(id)}/logs?start=${Math.floor(Date.now()/1000)-900}&direction=forward&last_lines=true`);return (x.data||[]).flatMap(g=>(g.values||[]).map(v=>({at:v[0],line:v[1]}))).slice(-150);}
  restart(id){return this.request(`/v1/projects/${encodeURIComponent(id)}/actions/restart`,{method:'POST'});}
  start(id){return this.request(`/v1/projects/${encodeURIComponent(id)}/actions/scale`,{method:'POST',json:{scale:1}});}
  stop(id){return this.request(`/v1/projects/${encodeURIComponent(id)}/actions/scale`,{method:'POST',json:{scale:0}});}
  delete(id){return this.request(`/v1/projects/${encodeURIComponent(id)}`,{method:'DELETE'});}
  create(data){return this.request('/v1/projects/',{method:'POST',json:data});}
  async deploy(id,archive,platform,port,onStage=()=>{},{buildCache=true,attribution='Rahban approved deployment'}={}){
    const form=new FormData();form.append('file',new Blob([archive],{type:'application/gzip'}),'source.tar.gz');
    const source=await this.request(`/v2/projects/${encodeURIComponent(id)}/sources`,{method:'POST',body:form});
    const sourceID=source.sourceID||source.sourceId||source._id;
    if(!sourceID)throw new Error('Liara upload returned no sourceID. Deployment stopped.');
    onStage('Source uploaded to Liara');
    return this.request(`/v2/projects/${encodeURIComponent(id)}/releases`,{method:'POST',json:{sourceID,type:platform,port,platformConfig:{},build:{cache:buildCache,...(platform==='docker'?{dockerfile:'Dockerfile'}:{})},message:attribution}});
  }
  release(id){return this.request(`/v1/releases/${encodeURIComponent(id)}`);}
}
