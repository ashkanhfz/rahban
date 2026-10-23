export async function waitForHealthy(probe,{attempts=15,required=3,interval=2000,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  let streak=0;const results=[];
  for(let i=0;i<attempts;i++){
    const result=await probe();results.push(result);streak=result?.ok?streak+1:0;
    if(streak>=required)return {healthy:true,results};
    if(i<attempts-1)await sleep(interval);
  }
  return {healthy:false,results};
}
