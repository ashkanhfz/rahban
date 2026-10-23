import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const app=await fetch('http://127.0.0.1:4310/healthz').then(r=>r.json());
const credential=JSON.parse(readFileSync(new URL('../data/local-access.json',import.meta.url),'utf8'));
const headers={Authorization:'Basic '+Buffer.from(credential.username+':'+credential.password).toString('base64')};
const grafana=await fetch('http://127.0.0.1:4311/api/health').then(r=>r.json());
const dashboard=await fetch('http://127.0.0.1:4311/api/dashboards/uid/rahban-operations',{headers}).then(r=>r.json());
const datasource=await fetch('http://127.0.0.1:4311/api/datasources/uid/rahban-prometheus/health',{headers}).then(r=>r.json());
const targets=await fetch('http://127.0.0.1:9090/api/v1/targets').then(r=>r.json());
const queries=[];
for(const panel of dashboard.dashboard.panels){
  for(const target of panel.targets||[]){
    const expression=target.expr.replaceAll('$service','.*');
    const response=await fetch('http://127.0.0.1:9090/api/v1/query?query='+encodeURIComponent(expression)).then(r=>r.json());
    queries.push({panel:panel.title,valid:response.status==='success',series:response.data?.result?.length||0,...(response.error?{error:response.error}:{})});
  }
}
const db=new DatabaseSync(new URL('../data/rahban.sqlite',import.meta.url),{readOnly:true});
const liveJob=db.prepare("SELECT body FROM records WHERE kind='job' ORDER BY created DESC").all().map(r=>JSON.parse(r.body)).find(j=>j.mode==='live'&&j.type==='deploy'&&j.releaseId);
const liveProbes=liveJob?db.prepare("SELECT at,ok,ms,code FROM probes WHERE mode='live' AND service=? ORDER BY at DESC LIMIT 3").all(liveJob.target):[];
db.close();
const liara=liveJob?{target:liveJob.target,releaseId:liveJob.releaseId,jobStatus:liveJob.status,url:`https://${liveJob.target}.liara.run`,latestProbes:liveProbes,note:'Actual Liara API upload/release and HTTP probes; API key is kept only in server memory.'}:'Not yet verified against a real account';
const report={at:new Date().toISOString(),app:app.status,grafana:grafana.version,dashboard:dashboard.dashboard.title,panels:dashboard.dashboard.panels.length,datasource:datasource.status,targets:targets.data.activeTargets.map(t=>({job:t.labels.job,health:t.health})),queries,liara,docker:'Compose config validated; Docker Hub pull returned 403; native Windows binaries used'};
writeFileSync(new URL('../VALIDATION.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(report.app!=='ok'||report.datasource!=='OK'||queries.some(q=>!q.valid)||report.targets.some(t=>t.health!=='up'))process.exitCode=1;
