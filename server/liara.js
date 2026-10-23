import {redact} from './agent.js';
const BASE='https://api.liara.ir';
export class Liara {
  constructor(credentials,fetcher=fetch){this.credentials=credentials;this.fetcher=fetcher;}
  async request(path,{method='GET',json,body}={}){
    const {token,team}=this.credentials();if(!token)throw new Error('Add your Liara token in Settings first.');
    const url=new URL(path,BASE);if(team)url.searchParams.set('teamID',team);
    const response=await this.fetcher(url,{method,headers:{Authorization:`Bearer ${token}`,...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(json):body,signal:AbortSignal.timeout(30000),redirect:'error'});
    const value=await response.json().catch(()=>({}));
    if(!response.ok){
      const stage=url.pathname.endsWith('/sources')?'source upload':url.pathname.endsWith('/releases')?'release creation':'request';
      const validation=response.status===400&&(typeof value.message==='string'||Array.isArray(value.message))?redact(String(value.message),[token]).slice(0,700):'';
      const error=new Error(response.status===402?'Insufficient credit. Top up your Liara account.':`Liara rejected ${stage} (HTTP ${response.status}).${validation?' '+validation:' Check the connection, permissions and service status.'}`);error.status=response.status;throw error;
    }
    return value;
  }
  async apps(){return (await this.request('/v1/projects')).projects||[];}
  async plans(){const x=await this.request('/v1/me');return x.plans||{};}
  async details(id){return (await this.request(`/v1/projects/${encodeURIComponent(id)}`)).project;}
  async logs(id){const x=await this.request(`/v2/projects/${encodeURIComponent(id)}/logs?start=${Math.floor(Date.now()/1000)-900}&direction=forward&last_lines=true`);return (x.data||[]).flatMap(g=>(g.values||[]).map(v=>({at:v[0],line:v[1]}))).slice(-150);}
  restart(id){return this.request(`/v1/projects/${encodeURIComponent(id)}/actions/restart`,{method:'POST'});}
  create(data){return this.request('/v1/projects/',{method:'POST',json:data});}
  async deploy(id,archive,platform,port,onStage=()=>{},{buildCache=true}={}){
    const form=new FormData();form.append('file',new Blob([archive],{type:'application/gzip'}),'source.tar.gz');
    const source=await this.request(`/v2/projects/${encodeURIComponent(id)}/sources`,{method:'POST',body:form});
    const sourceID=source.sourceID||source.sourceId||source._id;
    if(!sourceID)throw new Error('Liara upload returned no sourceID. Deployment stopped.');
    onStage('Source uploaded to Liara');
    return this.request(`/v2/projects/${encodeURIComponent(id)}/releases`,{method:'POST',json:{sourceID,type:platform,port,platformConfig:{},build:{cache:buildCache,...(platform==='docker'?{dockerfile:'Dockerfile'}:{})},message:'Rahban approved deployment'}});
  }
  release(id){return this.request(`/v1/releases/${encodeURIComponent(id)}`);}
}
