import {randomUUID} from 'node:crypto';

const recordId='rahban-runtime';

export function openRuntime(store,{clock=Date.now,bootId=randomUUID()}={}){
  const previous=store.get('runtime',recordId);
  const now=()=>new Date(clock()).toISOString();
  const startedAt=now(),instanceId=previous?.instanceId||randomUUID();
  const state={
    instanceId,signature:`rahban:${instanceId}`,bootId,startedAt,lastSeenAt:startedAt,stoppedAt:null,
    previousBootId:previous?.bootId||null,
    previousLastSeenAt:previous?.lastSeenAt||null,
    previousStoppedAt:previous?.stoppedAt||null,
    recovered:Boolean(previous),
  };
  const snapshot=()=>({...state});
  const persist=()=>{
    store.put('runtime',{...state,id:recordId,created:previous?.created||startedAt});
    return snapshot();
  };
  persist();
  return {
    snapshot,
    heartbeat(){
      if(state.stoppedAt)return snapshot();
      state.lastSeenAt=now();
      return persist();
    },
    stop(){
      if(state.stoppedAt)return snapshot();
      state.stoppedAt=state.lastSeenAt=now();
      return persist();
    },
  };
}
