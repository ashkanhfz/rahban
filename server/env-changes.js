import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {redact} from './agent.js';

const key=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const envChanges=z.object({updates:z.array(z.object({key,value:z.string().max(16000)})).max(100).default([]),remove:z.array(key).max(100).default([])}).superRefine((value,ctx)=>{
  const keys=[...value.updates.map(item=>item.key),...value.remove];
  if(!keys.length||new Set(keys).size!==keys.length)ctx.addIssue({code:'custom',message:'Choose at least one variable; each key can be changed only once.'});
});
export function envDigest(variables){return createHash('sha256').update(JSON.stringify(variables.map(({key,value})=>({key,value})).sort((a,b)=>a.key.localeCompare(b.key)))).digest('hex');}

// Values live only until this single-use approval expires. Persistent records
// contain names and fingerprints, never the supplied or existing values.
export function createEnvironmentChanges({ttl=900000}={}){
  const pending=new Map();
  return {
    async prepare(adapter,target,input){
      const changes=envChanges.parse(input),existing=await adapter.envs(target);
      if(pending.size>=100)throw new Error('Too many pending configuration changes. Finish or let an earlier request expire.');
      if(changes.remove.some(key=>!existing.some(item=>item.key===key)))throw new Error('A variable was already removed. Refresh the configuration.');
      const values=new Map(existing.map(item=>[item.key,item.value]));
      for(const key of changes.remove)values.delete(key);
      for(const item of changes.updates)values.set(item.key,item.value);
      const desired=[...values].map(([key,value])=>({key,value})),patchId=randomUUID();
      const timer=setTimeout(()=>pending.delete(patchId),ttl);timer.unref();
      pending.set(patchId,{target,desired,secrets:[...existing,...desired].map(item=>item.value),base:envDigest(existing),expires:Date.now()+ttl,timer});
      return {patchId,baseDigest:envDigest(existing),desiredDigest:envDigest(desired),updatedKeys:changes.updates.map(item=>item.key),removedKeys:changes.remove};
    },
    async apply(adapter,target,payload,onSubmit=()=>{}){
      const change=pending.get(payload.patchId);
      if(!change||change.target!==target||change.expires<Date.now())throw new Error('The private configuration draft expired. Enter the changes again.');
      pending.delete(payload.patchId);clearTimeout(change.timer);
      try{
        const current=await adapter.envs(target);
        if(envDigest(current)!==change.base||payload.baseDigest!==change.base||envDigest(change.desired)!==payload.desiredDigest)throw new Error('The app configuration changed. Refresh it and review a new proposal.');
        onSubmit();await adapter.updateEnvs(target,change.desired);
      }catch(error){throw Object.assign(new Error(redact(error.message,change.secrets)),{status:error.status,code:error.code});}
    },
  };
}
