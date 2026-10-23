import {performance} from 'node:perf_hooks';

// The caller pins the origin; redirects never forward a probe to another host.
export async function probeHttp(url,{timeoutMs=5000,fetcher=fetch}={}){
  const start=performance.now();let code=0;
  try{
    const response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});
    code=response.status;await response.body?.cancel();
  }catch{}
  return {code,ms:performance.now()-start,ok:code>=200&&code<300?1:0};
}

export async function waitForHealthy(probe,{attempts=15,required=3,interval=2000,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  let streak=0;const results=[];
  for(let i=0;i<attempts;i++){
    const result=await probe();results.push(result);streak=result?.ok?streak+1:0;
    if(streak>=required)return {healthy:true,results};
    if(i<attempts-1)await sleep(interval);
  }
  return {healthy:false,results};
}
