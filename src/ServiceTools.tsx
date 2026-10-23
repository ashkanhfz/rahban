import {useEffect, useRef, useState} from 'react';
import {ChevronDown, Copy, ExternalLink, RefreshCw} from 'lucide-react';
import './service-tools.css';

type Row=Record<string,any>;
type Props={service?:Row;api:(path:string,method?:string,body?:unknown)=>Promise<any>;run:(label:string,operation:()=>Promise<unknown>)=>Promise<void>;busy:boolean;onChecked?:(id:string)=>void};
const stamp=(value:string|number)=>new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function Metric({name,metric}:{name:string;metric?:Row}){
  const samples:Row[]=metric?.samples||[];
  return <div className="resource-tile"><span>{name}</span>{metric?.status==='available'&&samples.length?<><strong>{samples.map(s=>Number(s.value).toLocaleString('en-US',{maximumFractionDigits:3})).join(' / ')}{metric.unit&&<small> {metric.unit}</small>}</strong><small>{metric.unit?'Latest provider sample':'Raw API value · unit not specified'}</small>{samples.length>1&&<small>One value per app instance</small>}</>:<><strong>Unavailable</strong><small>{metric?.reason||'Load a resource report to check availability.'}</small></>}</div>;
}
export function ServiceTools({service,api,run,busy,onChecked}:Props){
  const [snapshot,setSnapshot]=useState<Row|null>(null),[monitor,setMonitor]=useState<Row|null>(null),[enabled,setEnabled]=useState(false),[interval,setIntervalMinutes]=useState(5),[domains,setDomains]=useState<Row[]|null>(null),[copied,setCopied]=useState('');
  const current=useRef('');current.current=(service?.accountScope||'')+':'+(service?.id||'');
  const prefix='/services/'+encodeURIComponent(service?.id||'');
  useEffect(()=>{
    let active=true;setSnapshot(null);setDomains(null);setMonitor(null);setEnabled(false);setIntervalMinutes(5);
    if(service)api(prefix+'/monitor').then(result=>{if(active){setMonitor(result);setEnabled(result.enabled);setIntervalMinutes(result.intervalMinutes);}}).catch(()=>{});
    return()=>{active=false;};
  },[service?.id,service?.accountScope]);
  if(!service)return null;
  const refresh=()=>run('resources',async()=>{const captured=current.current,result=await api(prefix+'/overview');if(captured===current.current)setSnapshot(result);});
  return <div className="service-tools">
    <details className="fold"><summary>Resources and health<ChevronDown size={15}/></summary><div className="fold-content">
      <div className="row spread wrap"><p className="field-note">{snapshot?'Observed '+stamp(snapshot.checkedAt):'Read the latest resource reports from Liara.'}</p><button disabled={busy} onClick={refresh}><RefreshCw size={14}/>{snapshot?'Refresh resources':'Load resources'}</button></div>
      <div className="resource-grid"><Metric name="CPU" metric={snapshot?.metrics?.cpu}/><Metric name="RAM" metric={snapshot?.metrics?.memory}/></div>
      {snapshot?.service?.state&&<p className="field-note">Provider status: {snapshot.service.state}</p>}
      {!!snapshot?.limitations?.length&&<p className="field-note">{snapshot.limitations.join(' ')}</p>}
      <p className="field-note">Resource samples alone do not establish the cause of a slow response. Investigate to compare them with logs and HTTP checks.</p>
    </div></details>
    <details className="fold"><summary>Scheduled checks<span className="muted">{monitor?.enabled?'On':'Off'}</span><ChevronDown size={15}/></summary><div className="fold-content">
      <p className="field-note">Checks HTTP, logs and resource reports. Problems appear in Activity. Repairs always need your approval.</p>
      <div className="row wrap"><label className="checkbox"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Enable health checks</label><div className="field monitor-interval"><label htmlFor="check-interval">Check every</label><select id="check-interval" value={interval} onChange={e=>setIntervalMinutes(Number(e.target.value))}>{[1,5,15,60].map(n=><option key={n} value={n}>{n} minute{n>1?'s':''}</option>)}</select></div></div>
      <div className="row wrap"><button disabled={busy} onClick={()=>run('monitor',async()=>{const captured=current.current,result=await api(prefix+'/monitor','POST',{enabled,intervalMinutes:interval});if(captured===current.current)setMonitor(result);})}>Save schedule</button><button disabled={busy} onClick={()=>run('check',async()=>{const result=await api(prefix+'/check','POST',{});onChecked?.(result.incident.id);})}>Check now</button></div>
      {monitor?.lastRun&&<p className="field-note">Last run: {stamp(monitor.lastRun)}{monitor.nextRun?' · Next: '+stamp(monitor.nextRun):''}</p>}
      {monitor?.lastError&&<p className="notice warning">{monitor.lastError}</p>}
      <p className="field-note">Runs while Rahban is online and this Liara account is connected. Missed checks are not replayed.</p>
    </div></details>
    <details className="fold"><summary>Custom domain<span className="muted">optional</span><ChevronDown size={15}/></summary><div className="fold-content">
      <p className="field-note">Your app can use its Liara address immediately. Add a custom domain when you are ready.</p>
      <ol className="domain-guide"><li>Open your app in Liara, choose <strong>Domains → Add domain</strong>, and enter the domain you own.</li><li>Copy the exact ALIAS/CNAME, ownership TXT and SSL challenge records from Liara to your DNS provider.</li><li>If you are changing DNS providers, enter that provider’s assigned nameservers at your registrar. For .ir domains, this is usually <a href="https://www.nic.ir" target="_blank" rel="noreferrer">IRNIC</a>. Keep existing mail records.</li><li>Check the records below, then enable SSL in Liara. DNS changes can take time to appear.</li></ol>
      <div className="row wrap"><a className="button" href="https://console.liara.ir" target="_blank" rel="noreferrer">Open Liara<ExternalLink size={13}/></a><button disabled={busy} onClick={()=>run('domains',async()=>{const captured=current.current,result=await api(prefix+'/domains');if(captured===current.current)setDomains(result.domains);})}><RefreshCw size={14}/>{domains?'Refresh domains':'Load domains'}</button><a href="https://docs.liara.ir/paas/domains/add-domain/" target="_blank" rel="noreferrer">Setup guide</a></div>
      {domains?.length===0&&<p className="field-note">No custom domains returned for this app. Add one in Liara, then refresh.</p>}
      {domains?.map(domain=><article className="domain-row" key={domain.id}><div className="row spread wrap"><strong>{domain.name}</strong><button disabled={busy} onClick={()=>run('domain-check',async()=>{const captured=current.current,next=await api(prefix+'/domains/'+encodeURIComponent(domain.id)+'/check','POST',{});if(captured!==current.current)return;setDomains(current=>current?.map(d=>d.id===domain.id?next:d)||null);})}>Check records</button></div><p className="field-note">Domain: {domain.status} · SSL: {domain.ssl}</p>{domain.cname&&<div className="dns-record"><span>CNAME target</span><code>{domain.cname}</code><button className="plain" aria-label={'Copy CNAME for '+domain.name} onClick={()=>run('copy',async()=>{await navigator.clipboard.writeText(domain.cname);setCopied(domain.id);})}><Copy size={13}/>{copied===domain.id?'Copied':'Copy'}</button></div>}<p className="field-note">Use Liara’s domain page for any ownership and SSL challenge records not returned by this API.</p></article>)}
    </div></details>
  </div>;
}
