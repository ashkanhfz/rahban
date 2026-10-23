import {z} from 'zod';

const optional=value=>value==null||(typeof value==='string'&&!value.trim())?undefined:value;
const number=(min,max)=>z.preprocess(optional,z.coerce.number().int().min(min).max(max).optional());
export const deploySettings=z.object({
  port:number(1,65535),
  healthPath:z.preprocess(optional,z.string().trim().max(200).regex(/^\/(?:[a-zA-Z0-9_-]+\/?)*$/).optional()),
  healthTimeoutMs:number(1000,30000),
  buildCache:z.preprocess(optional,z.boolean().optional()),
}).strict();

export function resolveSettings(source,settings={},legacyPort){
  const values=deploySettings.parse(settings??{});
  const fallbackPort=number(1,65535).parse(legacyPort);
  return {
    port:values.port??fallbackPort??source?.port??3000,
    healthPath:values.healthPath??'/',
    healthTimeoutMs:values.healthTimeoutMs??5000,
    buildCache:values.buildCache??true,
  };
}

export function previewDeployment(source,settings){
  const defaults=resolveSettings(source),resolved=resolveSettings(source,settings);
  const checks=[...source.checks,{name:'Deployment settings are valid',ok:true}];
  return {settings:resolved,defaults,detected:{port:source.portDetected?source.port:null},checks,ready:source.ready};
}
