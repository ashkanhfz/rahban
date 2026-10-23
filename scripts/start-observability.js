import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const runtime=resolve(process.argv[2]||join(root,'data/runtime'));
function find(dir,name){if(!existsSync(dir))return null;for(const ent of readdirSync(dir,{withFileTypes:true})){if(ent.isDirectory()){const result=find(join(dir,ent.name),name);if(result)return result;}else if(ent.name===name)return join(dir,ent.name);}return null;}
const grafana=find(join(runtime,'grafana'),'grafana.exe')||find(join(runtime,'grafana'),'grafana-server.exe');
const prometheus=find(join(runtime,'prometheus'),'prometheus.exe');
if(!grafana||!prometheus)throw new Error('Official binaries missing. Run python scripts/download-runtime.py first, or pass runtime folder.');
const data=join(root,'data/observability');mkdirSync(join(data,'provisioning/datasources'),{recursive:true});mkdirSync(join(data,'provisioning/dashboards'),{recursive:true});mkdirSync(join(data,'grafana'),{recursive:true});mkdirSync(join(data,'prometheus'),{recursive:true});
const slash=p=>p.replaceAll('\\','/');
const accessPath=join(root,'data/local-access.json');
const access=existsSync(accessPath)?JSON.parse(readFileSync(accessPath,'utf8')):{username:'rahban',password:randomBytes(24).toString('base64url')};
writeFileSync(accessPath,JSON.stringify(access,null,2));
writeFileSync(join(root,'data/local-access.txt'),`Grafana: http://localhost:4311\nUsername: ${access.username}\nPassword: ${access.password}\n\nLocal credentials. Do not commit or share this file.\n`);
writeFileSync(join(data,'prometheus.yml'),`global:\n  scrape_interval: 5s\n  evaluation_interval: 10s\nrule_files:\n  - ${JSON.stringify(slash(join(root,'ops/prometheus/alerts.yml')))}\nscrape_configs:\n  - job_name: rahban\n    static_configs:\n      - targets: ['127.0.0.1:4310']\n`);
writeFileSync(join(data,'provisioning/datasources/prometheus.yml'),readFileSync(join(root,'ops/grafana/provisioning/datasources/prometheus.yml'),'utf8').replace('$PROMETHEUS_URL','http://127.0.0.1:9090'));
writeFileSync(join(data,'provisioning/dashboards/default.yml'),`apiVersion: 1\nproviders:\n  - name: Rahban\n    orgId: 1\n    folder: Rahban\n    type: file\n    disableDeletion: true\n    updateIntervalSeconds: 15\n    allowUiUpdates: false\n    options:\n      path: ${JSON.stringify(slash(join(root,'ops/grafana/dashboards')))}\n`);
const grafanaHome=resolve(grafana,'../..');
const ini=`[paths]\ndata = ${slash(join(data,'grafana'))}\nlogs = ${slash(join(data,'logs'))}\nplugins = ${slash(join(data,'plugins'))}\nprovisioning = ${slash(join(data,'provisioning'))}\n[server]\nhttp_addr = 127.0.0.1\nhttp_port = 4311\nroot_url = http://localhost:4311/\n[security]\nadmin_user = ${access.username}\nadmin_password = ${access.password}\ndisable_gravatar = true\ncookie_samesite = strict\n[auth.anonymous]\nenabled = false\n[users]\nallow_sign_up = false\n[analytics]\nreporting_enabled = false\ncheck_for_updates = false\n[plugins]\npublic_key_retrieval_disabled = true\npreinstall_disabled = true\n`;
writeFileSync(join(data,'grafana.ini'),ini);
async function healthy(url){try{return (await fetch(url,{signal:AbortSignal.timeout(1500)})).ok;}catch{return false;}}
const pidPath=join(data,'pids.json');
const pids=existsSync(pidPath)?JSON.parse(readFileSync(pidPath,'utf8')):{};
const running=pid=>{try{if(!pid)return false;process.kill(pid,0);return true;}catch{return false;}};
if(await healthy('http://127.0.0.1:9090/-/ready')||running(pids.prometheus))console.log('Prometheus is responding or starting; not starting a duplicate.');
else{const child=spawn(prometheus,[`--config.file=${join(data,'prometheus.yml')}`,`--storage.tsdb.path=${join(data,'prometheus')}`,'--web.listen-address=127.0.0.1:9090','--storage.tsdb.retention.time=7d'],{cwd:root,detached:true,windowsHide:true,stdio:'ignore'});child.unref();pids.prometheus=child.pid;}
if(await healthy('http://127.0.0.1:4311/api/health')||running(pids.grafana))console.log('Grafana is responding or starting; not starting a duplicate.');
else{const args=grafana.endsWith('grafana-server.exe')?[]:['server'];const child=spawn(grafana,[...args,`--homepath=${grafanaHome}`,`--config=${join(data,'grafana.ini')}`],{cwd:grafanaHome,detached:true,windowsHide:true,stdio:'ignore'});child.unref();pids.grafana=child.pid;}
writeFileSync(join(data,'pids.json'),JSON.stringify(pids));
console.log('Observability started. Grafana: http://localhost:4311 | Prometheus: http://localhost:9090');
console.log('Grafana login is stored locally in data/local-access.txt (ignored by Git).');
