import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowRight, Check, CheckCircle2, ChevronDown, ExternalLink, FolderArchive, GitBranch, Loader2, LogOut, RefreshCw, Settings2, Upload, X} from 'lucide-react';
import './styles.css';

type Row = Record<string, any>;
type DeploySettings = {port: number|null; healthPath: string|null; healthTimeoutMs: number|null; buildCache: boolean|null};
let csrf = '';
let sessionGeneration = 0;
let sessionRefresh: Promise<void>|null = null;
function renewSession() {
  if (!sessionRefresh) sessionRefresh = api('/session').then(result => {csrf = result.csrf; sessionGeneration++;}).finally(() => {sessionRefresh = null;});
  return sessionRefresh;
}
async function api(path: string, method = 'GET', body?: unknown, retry = true): Promise<any> {
  const response = await fetch('/api' + path, {method, headers: {...(body instanceof FormData ? {} : {'Content-Type': 'application/json'}), 'x-csrf-token': csrf}, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json();
  if (response.status === 401 && data.loginRequired) { window.location.assign('/auth/login'); throw new Error('Please sign in again.'); }
  if (response.status === 401 && retry && path !== '/session') {await renewSession(); return api(path, method, body, false);}
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}
const number = (n: number) => Number(n).toLocaleString('en-US');
const date = (value: string|number) => new Date(value).toLocaleDateString('en-US', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
const statusNames: Row = {running:'Running', succeeded:'Completed', failed:'Failed', needs_attention:'Needs review', interrupted:'Interrupted; review required', pending:'Awaiting approval', completed:'Completed', expired:'Expired', rejected:'Rejected', executing:'Running', open:'Investigating', resolved:'Resolved', observed:'Reviewed'};
function Badge({status}: {status: string}) { return <span className={'badge ' + status}>{statusNames[status] || status}</span>; }
function Checks({items}: {items: Row[]}) { return <ul className="checks">{items.map((item, i) => <li key={i} className={item.ok ? '' : 'warning'}><span aria-hidden="true">{item.ok ? '✓' : '!'}</span>{item.name}</li>)}</ul>; }
function ResolvedSettings({settings}: {settings: Row}) {
  return <dl className="facts"><div><dt>App port</dt><dd dir="ltr">{settings.port}</dd></div><div><dt>Health check path</dt><dd dir="ltr">{settings.healthPath}</dd></div><div><dt>Response timeout</dt><dd>{number(settings.healthTimeoutMs / 1000)} seconds</dd></div><div><dt>Build cache</dt><dd>{settings.buildCache ? 'Enabled' : 'Disabled'}</dd></div></dl>;
}
function ServiceSelect({services, value, onChange, id}: {services: Row[], value: string, onChange: (value: string) => void, id: string}) {
  return <select id={id} value={services.some(service => service.id === value) ? value : ''} onChange={event => onChange(event.target.value)}><option value="" disabled>Select a service</option>{services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select>;
}
function Job({job, services, onVerify, busy}: {job: Row, services: Row[], onVerify: (id: string) => void, busy: boolean}) {
  const service = services.find(item => item.id === job.target);
  const site = service?.domain && /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(service.domain) ? `https://${service.domain}` : null;
  return <article className="job"><div className="row spread"><div><strong>{job.title}</strong><small className="technical">{job.target}</small></div><Badge status={job.status}/></div>
    <ol className="job-steps">{(job.steps || []).map((item: Row, i: number) => <li key={i} className={item.status === 'failed' ? 'warning' : ''}>{item.status === 'failed' ? '!' : '✓'} {item.title}</li>)}</ol>
    {job.message && <p className="job-message">{job.message}</p>}
    <div className="row wrap">{site && job.type === 'deploy' && job.status === 'succeeded' && <a className="button primary" href={site} target="_blank" rel="noreferrer">Open website<ExternalLink size={15}/></a>}{(job.status === 'needs_attention' || (job.status === 'interrupted' && job.releaseId)) && <button disabled={busy} onClick={() => onVerify(job.id)}><RefreshCw size={15}/>Check health again</button>}<time className="muted">{date(job.created)}</time></div>
  </article>;
}

function App() {
  const [state, setState] = useState<Row|null>(null), [page, setPage] = useState('deploy'), [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [step, setStep] = useState(1);
  const [source, setSource] = useState<Row|null>(null), [repo, setRepo] = useState(''), [branch, setBranch] = useState('main');
  const bootId = useRef(''), [recovered, setRecovered] = useState(false);
  const [selected, setSelected] = useState(''), [deployTarget, setDeployTarget] = useState(''), [preview, setPreview] = useState<Row|null>(null);
  const [port, setPort] = useState(''), [healthPath, setHealthPath] = useState(''), [healthTimeout, setHealthTimeout] = useState(''), [buildCache, setBuildCache] = useState('');
  const [plans, setPlans] = useState<Row|null>(null), [planId, setPlanId] = useState(''), [bundleId, setBundleId] = useState(''), [appName, setAppName] = useState('');
  const [approval, setApproval] = useState<Row|null>(null), [confirmation, setConfirmation] = useState(''), [consent, setConsent] = useState(false), [jobId, setJobId] = useState('');
  const [selectedIncident, setSelectedIncident] = useState(''), [prompt, setPrompt] = useState(''), [logData, setLogData] = useState<Row|null>(null);
  const [token, setToken] = useState(''), [team, setTeam] = useState(''), [modelBase, setModelBase] = useState(''), [modelKey, setModelKey] = useState(''), [modelName, setModelName] = useState(''), [share, setShare] = useState(false);
  const load = async () => {
    try {
      const previousSession = sessionGeneration;
      const next = await api('/state');
      if (next.runtime?.bootId) {
        if (bootId.current && bootId.current !== next.runtime.bootId) {if (sessionGeneration === previousSession) await renewSession(); setRecovered(true); setApproval(null);}
        bootId.current = next.runtime.bootId;
      }
      setState(next); setOnline(true); return next;
    } catch (error) {setOnline(false); throw error;}
  };
  const run = async (label: string, operation: () => Promise<unknown>) => { if (busy) return; setBusy(label); setMessage(''); try { await operation(); await load(); } catch (error) { setMessage((error as Error).message); } finally { setBusy(''); } };
  useEffect(() => { renewSession().then(load).catch(error => setMessage(error.message)); const timer = setInterval(() => load().catch(() => {}), 4000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (state?.settings) { setTeam(state.settings.team || ''); setModelBase(state.settings.llmBase || ''); setModelName(state.settings.llmModel || ''); setShare(!!state.settings.shareEvidence); } }, [state?.settings?.team, state?.settings?.llmBase, state?.settings?.llmModel, state?.settings?.shareEvidence]);
  useEffect(() => {
    const services: Row[] = state?.services || [];
    if (!services.some(item => item.id === selected)) setSelected(services[0]?.id || '');
    const destinations = services.filter(item => item.mode === 'live' && item.platform === (source?.platform || 'node'));
    if (!destinations.some(item => item.id === deployTarget)) setDeployTarget(destinations[0]?.id || '');
  }, [state?.services?.map((item: Row) => item.id + item.platform).join(','), state?.mode, source?.platform]);
  useEffect(() => { setPreview(null); if (step === 3 && !jobId) setStep(2); }, [source?.id, deployTarget, port, healthPath, healthTimeout, buildCache, state?.mode]);
  useEffect(() => {
    if (!approval && !logData) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {setApproval(null); setLogData(null);}
      if (event.key !== 'Tab') return;
      const fields = document.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled), [role="dialog"] input:not(:disabled), [role="dialog"] a[href]');
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [approval, logData, busy]);
  const navigate = (next: string) => {setPage(next); setMessage(''); window.scrollTo({top: 0});};
  const acceptSource = (next: Row) => {setSource(next); setPreview(null); setJobId(''); setPort(''); setHealthPath(''); setHealthTimeout(''); setBuildCache('');};
  const openApproval = (item: Row) => {setApproval(item); setConfirmation(''); setConsent(false);};
  const propose = async (type: string, target: string, extras: Row = {}) => openApproval(await api('/proposals', 'POST', {type, target, ...extras}));
  const readSettings = (): DeploySettings => {
    const numeric = (value: string, label: string) => { if (!value.trim()) return null; const parsed = Number(value); if (!Number.isInteger(parsed)) throw new Error(`${label} must be a whole number.`); return parsed; };
    return {port: numeric(port, 'Port'), healthPath: healthPath.trim() || null, healthTimeoutMs: numeric(healthTimeout, 'Response timeout'), buildCache: buildCache === '' ? null : buildCache === 'true'};
  };
  const review = () => run('preview', async () => {if (!source || !deployTarget) throw new Error('Select a project and destination.'); const result = await api('/deployment/preview', 'POST', {sourceId: source.id, settings: readSettings()}); setPreview(result); if (result.ready) {setJobId(''); setStep(3);} else setMessage('Resolve the highlighted checks to continue.');});
  const investigate = () => run('investigate', async () => { const result = await api('/incidents', 'POST', {target: selected, message: prompt || 'Check service health'}); setSelectedIncident(result.id); setPrompt(''); });
  const verify = (id: string) => run('verify', () => api('/jobs/' + id + '/verify', 'POST', {}));
  const switchMode = (mode: string) => run('mode', async () => {await api('/mode', 'POST', {mode}); if (mode === 'live') await api('/sync', 'POST', {}); setApproval(null); setJobId('');});
  if (!state) return <main className="boot"><h1>Rahban</h1><p><Loader2 size={16} className="spin"/>Connecting…</p>{message && <div role="alert"><p>{message}</p><button onClick={() => window.location.reload()}>Retry</button></div>}</main>;

  const live = state.mode === 'live', services: Row[] = state.services || [], jobs: Row[] = state.jobs || [], incidents: Row[] = state.incidents || [];
  const pending: Row[] = (state.approvals || []).filter((item: Row) => item.status === 'pending');
  const destinations = services.filter(item => item.mode === 'live' && item.platform === (source?.platform || 'node'));
  const incident = incidents.find(item => item.id === selectedIncident) || incidents[0];
  const currentJob = jobs.find(item => item.id === jobId);
  const last = (state.probes || []).filter((item: Row) => item.service === selected).at(-1);
  const options: Row[] = Object.entries(plans?.projects || {}).filter(([, item]: any) => item.available && (!item.region || item.region === 'iran')).map(([id, item]: any) => ({id, ...item}));
  const bundles: Row[] = Object.entries(plans?.projectBundlePlans?.[planId] || {}).filter(([, item]: any) => item.available).map(([id, item]: any) => ({id, ...item}));
  const titles: Row = {deploy: 'Deploy project', incidents: 'Check service', settings: 'Settings'};
  const otherJobs = jobs.filter(item => item.id !== currentJob?.id || step !== 3 || page !== 'deploy');
  const hasActiveJob = otherJobs.some(item => item.status === 'running');

  return <div className="app">
    <header className="header"><button className="brand" onClick={() => navigate('deploy')}><span className="brand-mark" aria-hidden="true">r</span>Rahban</button><nav aria-label="Pages"><button aria-current={page === 'deploy' ? 'page' : undefined} onClick={() => navigate('deploy')}>Deploy</button><button aria-current={page === 'incidents' ? 'page' : undefined} onClick={() => navigate('incidents')}>Check service</button></nav><div className="header-end"><button aria-label="Settings" className={'plain ' + (page === 'settings' ? 'active' : '')} onClick={() => navigate('settings')}><Settings2 size={16}/><span>Settings</span></button>{state.hosting?.public && <form action="/auth/logout" method="post"><button className="plain" type="submit" aria-label="Sign out"><LogOut size={15}/><span>Sign out</span></button></form>}</div></header>
    <main className="main"><div className="page-title"><h1>{titles[page]}</h1><span className={'environment ' + (live ? 'live' : '')}><span aria-hidden="true"/>{live ? 'Liara connected' : 'Demo environment'}</span></div>
      {recovered && <div className="notice message" role="status"><span>Rahban restarted. Review interrupted operations before retrying.</span><button className="plain" aria-label="Dismiss recovery notice" onClick={() => setRecovered(false)}><X size={16}/></button></div>}
      {!online && <p className="notice warning" role="alert">Connection lost. Displayed information may be outdated. <button className="plain" disabled={!!busy} onClick={() => run('refresh', load)}>Retry</button></p>}
      {message && <div className="notice message" role="alert"><span>{message}</span><button className="plain" aria-label="Dismiss message" onClick={() => setMessage('')}><X size={16}/></button></div>}
      {busy && <p className="request-status" role="status"><Loader2 size={14} className="spin"/>{busy === 'preview' ? 'Checking settings…' : busy === 'upload' || busy === 'github' ? 'Inspecting project…' : 'Working…'}</p>}

      {page === 'deploy' && <>
        <ol className="steps" aria-label="Deployment steps">{['Project', 'Destination', 'Review'].map((label, i) => <li key={label} className={step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''}><button disabled={!!busy || i + 1 > step} aria-current={step === i + 1 ? 'step' : undefined} onClick={() => {setStep(i + 1); setJobId('');}}><span>{step > i + 1 ? <Check size={13}/> : number(i + 1)}</span>{label}</button></li>)}</ol>
        <section className="workspace" aria-label={['', 'Choose project', 'Choose destination', 'Review deployment'][step]}>
          {step === 1 && <>
            <h2>Choose your project</h2>
            <div className="source-upload"><FolderArchive size={28} strokeWidth={1.5} aria-hidden="true"/><div><strong>Project archive</strong><p className="muted">ZIP file, up to 10 MB</p></div><div className="source-actions"><label className={'button primary file-button ' + (busy ? 'disabled' : '')}><Upload size={16}/>Choose ZIP file<input aria-label="Choose ZIP file" type="file" accept=".zip" disabled={!!busy} onChange={event => {const file = event.target.files?.[0]; event.target.value = ''; if (file) run('upload', async () => {const data = new FormData(); data.append('file', file); acceptSource(await api('/sources/upload', 'POST', data));});}}/></label><button className="plain" disabled={!!busy} onClick={() => run('sample', async () => acceptSource(await api('/sources/sample', 'POST', {})))}>Use sample project</button></div></div>
            <details className="fold"><summary><GitBranch size={16}/>Import from GitHub<ChevronDown size={15}/></summary><form className="fold-content" onSubmit={event => {event.preventDefault(); run('github', async () => acceptSource(await api('/sources/github', 'POST', {url: repo.trim(), branch: branch.trim() || 'main'})));}}><div className="field"><label htmlFor="repo">Public repository URL</label><input id="repo" type="url" dir="ltr" placeholder="https://github.com/you/project" value={repo} onChange={event => setRepo(event.target.value)} required/></div><div className="field"><label htmlFor="branch">Branch</label><input id="branch" dir="ltr" value={branch} onChange={event => setBranch(event.target.value)}/></div><button disabled={!!busy || !repo.trim()} type="submit">Import and inspect</button></form></details>
            {source && <div className="source-result"><div className="row spread"><strong className="technical">{source.name || source.label}</strong><span className="source-kind"><bdi>{source.platform === 'docker' ? 'Docker' : source.platform === 'node' ? 'Node.js' : 'Unsupported project'}</bdi> · {number(source.fileCount)} files</span></div>{source.github && <p className="field-note repository"><GitBranch size={14}/><span>{source.github.repo} · {source.github.branch}{source.github.commit ? ' · ' + source.github.commit.slice(0, 7) : ''}</span></p>}<Checks items={source.checks || []}/>{!source.ready && source.summary && <p className="notice warning">{source.summary}</p>}{!!(source.requiredEnv ?? source.env ?? []).length && <p className="notice">Set <bdi>{(source.requiredEnv ?? source.env ?? []).join(', ')}</bdi> in the Liara console before deployment.</p>}</div>}
            <div className="step-actions"><button className="primary" disabled={!!busy || !source?.ready} onClick={() => setStep(2)}>Continue<ArrowRight size={16}/></button></div>
          </>}
          {step === 2 && <>
            <h2>Deployment destination</h2>
            {!live ? <div className="connect-note"><p>Connect a Liara account to deploy.</p>{state.settings.connected ? <button className="primary" disabled={!!busy} onClick={() => switchMode('live')}>Use Liara</button> : <button className="primary" onClick={() => navigate('settings')}>Connect to Liara</button>}</div> : <>
              <div className="field"><label htmlFor="deploy-service">Destination service</label><div className="input-row"><ServiceSelect id="deploy-service" services={destinations} value={deployTarget} onChange={setDeployTarget}/><button aria-label="Refresh services" disabled={!!busy} onClick={() => run('sync', () => api('/sync', 'POST', {}))}><RefreshCw size={16}/></button></div>{!destinations.length && <p className="field-note">No compatible service found. Create one below.</p>}</div>
              <details className="fold" open={!destinations.length || undefined}><summary>Create a new service<ChevronDown size={15}/></summary><div className="fold-content">
                {!plans ? <button disabled={!!busy} onClick={() => run('plans', async () => {const result = await api('/plans' + (source ? '?sourceId=' + source.id : '')); setPlans(result); setPlanId(result.recommendation?.planID || ''); setBundleId(result.recommendation?.bundlePlanID || '');})}>Get recommended plan</button> : <>
                  <div className="field"><label htmlFor="app-name">Service name</label><input id="app-name" dir="ltr" placeholder="my-app" value={appName} onChange={event => setAppName(event.target.value)}/></div>
                  <div className="field"><label htmlFor="plan">Plan</label><select id="plan" value={planId} onChange={event => {setPlanId(event.target.value); setBundleId('');}}><option value="">Select a plan</option>{options.map(item => <option key={item.id} value={item.id}>{item.id} · About {number(Number(item.price) * 720)} toman / month</option>)}</select></div>
                  <div className="field"><label htmlFor="bundle">Feature bundle</label><select id="bundle" value={bundleId} onChange={event => setBundleId(event.target.value)}><option value="">Select a bundle</option>{bundles.map(item => <option key={item.id} value={item.id}>{item.id} · {number(item.displayPrice || 0)} toman / month</option>)}</select></div>
                  {plans.recommendation?.reason && <p className="field-note">{plans.recommendation.reason}</p>}<p className="field-note">Add credit in the <a href="https://console.liara.ir" target="_blank" rel="noreferrer">Liara console</a>.</p>
                  <button disabled={!!busy || !appName.trim() || !planId || !bundleId} onClick={() => run('create', () => propose('create-app', appName.trim(), {planID: planId, bundlePlanID: bundleId, platform: source?.platform || 'node'}))}>Review cost and create</button>
                </>}
              </div></details>
            </>}
            <details className="fold advanced"><summary>Advanced settings <span className="muted">optional</span><ChevronDown size={15}/></summary><div className="fold-content"><p className="field-note">Leave fields empty to use the defaults.</p><div className="field-grid">
              <div className="field"><label htmlFor="port">App port</label><input id="port" type="number" min="1" max="65535" dir="ltr" placeholder={String(source?.port || 3000)} value={port} onChange={event => setPort(event.target.value)}/></div>
              <div className="field"><label htmlFor="health-path">Health check path</label><input id="health-path" dir="ltr" placeholder="/" value={healthPath} onChange={event => setHealthPath(event.target.value)}/></div>
              <div className="field"><label htmlFor="health-timeout">Response timeout (ms)</label><input id="health-timeout" type="number" min="1000" max="30000" dir="ltr" placeholder="5000" value={healthTimeout} onChange={event => setHealthTimeout(event.target.value)}/></div>
              <div className="field"><label htmlFor="build-cache">Build cache</label><select id="build-cache" value={buildCache} onChange={event => setBuildCache(event.target.value)}><option value="">Default: enabled</option><option value="true">Enabled</option><option value="false">Disabled</option></select></div>
            </div></div></details>
            {preview && !preview.ready && <Checks items={preview.checks || []}/>}
            <div className="step-actions"><button className="primary" disabled={!!busy || !live || !source || !deployTarget} onClick={review}>Review deployment<ArrowRight size={16}/></button><button className="plain" disabled={!!busy} onClick={() => setStep(1)}>Back</button></div>
          </>}
          {step === 3 && !currentJob && <>
            <h2>Review deployment</h2><dl className="facts identity"><div><dt>Project</dt><dd className="technical">{source?.name || source?.label}</dd></div><div><dt>Destination service</dt><dd className="technical">{deployTarget}</dd></div></dl>
            {preview && <><ResolvedSettings settings={preview.settings}/><p className="field-note">These settings will be used. Empty fields have been filled with defaults.</p><details className="fold"><summary>Project checks<ChevronDown size={15}/></summary><Checks items={preview.checks || []}/></details></>}
            <div className="step-actions"><button className="primary" disabled={!!busy || !preview?.ready || !live} onClick={() => run('propose', () => propose('deploy', deployTarget, {sourceId: source?.id, settings: preview?.settings}))}>Approve deployment<ArrowRight size={16}/></button><button className="plain" disabled={!!busy} onClick={() => setStep(2)}>Edit settings</button></div>
          </>}
          {step === 3 && currentJob && <><h2>Deployment result</h2><Job job={currentJob} services={services} onVerify={verify} busy={!!busy}/>{currentJob.status !== 'running' && <button className="plain" onClick={() => {setJobId(''); setStep(1);}}>Deploy again</button>}</>}
          {step === 2 && currentJob?.type === 'create-app' && <Job job={currentJob} services={services} onVerify={verify} busy={!!busy}/>}
        </section>
      </>}

      {page === 'incidents' && <section className="workspace">
        <form onSubmit={event => {event.preventDefault(); investigate();}}><div className="field"><label htmlFor="inspect-service">Service</label><ServiceSelect id="inspect-service" services={services} value={selected} onChange={setSelected}/></div>
          {last && <p className="service-status">{Date.now() - last.at > 20000 ? 'Last check' : last.ok ? 'Healthy response' : 'Needs attention'} · <bdi>HTTP {last.code || '—'}</bdi> · {number(last.ms)} ms</p>}
          <div className="field"><label htmlFor="problem">What is wrong? <span className="muted">optional</span></label><input id="problem" placeholder="For example: the site returns HTTP 500" value={prompt} maxLength={2000} onChange={event => setPrompt(event.target.value)}/></div><div className="row wrap"><button className="primary" type="submit" disabled={!!busy || !selected}>Investigate</button><button type="button" disabled={!!busy || !selected} onClick={() => run('logs', async () => setLogData(await api('/logs/' + selected)))}>View logs</button></div>
        </form>
        {incident && <article className="incident"><div className="row spread"><h2>{incident.title}</h2><Badge status={incident.status}/></div><p className="field-note"><bdi>{incident.target}</bdi> · {date(incident.created)}</p>
          {(incident.hypotheses || []).map((item: Row, i: number) => <div className="finding" key={i}><h3>{item.title}</h3><p>{item.next}</p><details><summary>Evidence</summary><pre dir="ltr">{item.evidence}</pre></details></div>)}
          {incident.advice && <p className="advice">{incident.advice}</p>}{incident.modelError && <p className="notice warning">{incident.modelError}</p>}{incident.limitation && <p className="field-note">{incident.limitation}</p>}
          {incident.status === 'resolved' ? <p className="notice success">{incident.resolution}</p> : <button disabled={!!busy} onClick={() => run('repair', () => propose(live ? 'restart' : 'restore-demo', incident.target))}>{live ? 'Review restart' : 'Review recovery'}</button>}
          <a className="report-link" href={'/api/incidents/' + incident.id + '/report'} download>Download report</a>
        </article>}
        {incidents.length > 1 && <details className="fold"><summary>Previous investigations<ChevronDown size={15}/></summary><div className="compact-list">{incidents.map(item => <button className="list-row" key={item.id} onClick={() => setSelectedIncident(item.id)}><span>{item.title}<small>{item.target}</small></span><Badge status={item.status}/></button>)}</div></details>}
        {!live && <details className="fold"><summary>Test a failure<ChevronDown size={15}/></summary><div className="fold-content"><p className="field-note">Only the local demo service is affected.</p><div className="row wrap"><button disabled={!!busy} onClick={() => run('fault', async () => {await api('/demo/fault', 'POST', {type: 'error'}); await api('/probe/sandbox-store', 'POST', {});})}>Trigger HTTP 503</button><button disabled={!!busy} onClick={() => run('fault', async () => {await api('/demo/fault', 'POST', {type: 'slow'}); await api('/probe/sandbox-store', 'POST', {});})}>Simulate slow response</button></div></div></details>}
      </section>}

      {page === 'settings' && <section className="workspace">
        <h2>Connect to Liara</h2><p className="muted">{state.settings.connected ? 'Account connected.' : 'Get your API token from the Liara console.'} <a href="https://console.liara.ir" target="_blank" rel="noreferrer">Open console<ExternalLink size={12}/></a></p>
        <form onSubmit={event => {event.preventDefault(); const suppliedToken = token; setToken(''); run('connect', async () => {await api('/settings', 'POST', {...(suppliedToken ? {token: suppliedToken} : {}), team}); await api('/mode', 'POST', {mode: 'live'}); await api('/sync', 'POST', {}); setMessage('Connected.'); setPage('deploy');});}}>
          <div className="field"><label htmlFor="liara-token">Liara API token</label><input id="liara-token" type="password" autoComplete="off" dir="ltr" value={token} onChange={event => setToken(event.target.value)} placeholder={state.settings.connected ? 'Enter a new token to replace the current one' : ''}/></div>
          <details className="fold"><summary>Team account<ChevronDown size={15}/></summary><div className="fold-content field"><label htmlFor="team-id">Team ID <span className="muted">optional</span></label><input id="team-id" dir="ltr" value={team} onChange={event => setTeam(event.target.value)}/></div></details>
          <p className="field-note">The key is not saved in the browser. You may need to reconnect after a server restart.</p><div className="row wrap"><button type="submit" className="primary" disabled={!!busy || (!token && !state.settings.connected)}>Connect and continue</button>{state.settings.connected && <button type="button" className="plain" disabled={!!busy} onClick={() => run('disconnect', () => api('/disconnect', 'POST', {}))}>Disconnect</button>}</div>
        </form>
        <details className="fold"><summary>Analysis model <span className="muted">optional</span><ChevronDown size={15}/></summary><form className="fold-content" onSubmit={event => {event.preventDefault(); const suppliedKey = modelKey; setModelKey(''); run('model', async () => {await api('/settings', 'POST', {llmBase: modelBase, llmModel: modelName, ...(suppliedKey ? {llmKey: suppliedKey} : {}), shareEvidence: share}); setMessage('Model settings saved.');});}}>
          <p className="field-note">Optional for troubleshooting. Not needed to deploy.</p><div className="field"><label htmlFor="model-base">API URL</label><input id="model-base" type="url" dir="ltr" placeholder="https://provider.example/v1" value={modelBase} onChange={event => setModelBase(event.target.value)}/></div><div className="field"><label htmlFor="model-name">Model name</label><input id="model-name" dir="ltr" value={modelName} onChange={event => setModelName(event.target.value)}/></div><div className="field"><label htmlFor="model-key">API key</label><input id="model-key" type="password" autoComplete="off" dir="ltr" value={modelKey} onChange={event => setModelKey(event.target.value)}/></div><label className="checkbox"><input type="checkbox" checked={share} onChange={event => setShare(event.target.checked)}/><span>Send the request and error evidence to this provider for analysis. Logs may still contain sensitive data.</span></label><button type="submit" disabled={!!busy || !modelBase || !modelName}>Save model</button>
        </form></details>
        {state.runtime && <details className="fold"><summary>Runtime information<ChevronDown size={15}/></summary><dl className="facts runtime"><div><dt>Instance</dt><dd className="technical">{state.runtime.instanceId}</dd></div><div><dt>Started</dt><dd>{date(state.runtime.startedAt)}</dd></div><div><dt>Boot</dt><dd className="technical">{state.runtime.bootId}</dd></div><div><dt>Recovery</dt><dd>{state.runtime.recovered ? 'Restored from saved state' : 'First start'}</dd></div></dl></details>}
        <details className="fold"><summary>Demo environment<ChevronDown size={15}/></summary><div className="fold-content"><p className="field-note">Inspect projects and practice troubleshooting without deploying to Liara.</p><div className="row wrap"><button disabled={!!busy || !live} onClick={() => switchMode('demo')}>Use demo environment</button>{state.settings.connected && <button disabled={!!busy || live} onClick={() => switchMode('live')}>Use Liara</button>}</div></div></details>
      </section>}

      {page !== 'settings' && <div className="secondary">
        {pending.length > 0 && <details className="fold" open><summary>Awaiting your approval <span className="count">{number(pending.length)}</span><ChevronDown size={15}/></summary><div className="compact-list">{pending.map(item => <div className="list-row" key={item.id}><div><strong>{item.title}</strong><small className="technical">{item.target}</small></div><div className="row"><button disabled={!!busy} onClick={() => openApproval(item)}>Review</button><button className="plain" disabled={!!busy} onClick={() => run('reject', () => api('/approvals/' + item.id + '/reject', 'POST', {}))}>Reject</button></div></div>)}</div></details>}
        {otherJobs.length > 0 && <details className="fold" open={hasActiveJob || undefined}><summary>Recent operations {hasActiveJob && <span className="muted">Running</span>}<ChevronDown size={15}/></summary>{otherJobs.slice(0, 6).map(item => <Job key={item.id} job={item} services={services} onVerify={verify} busy={!!busy}/>)}</details>}
        {(state.audit || []).length > 0 && <details className="fold"><summary>History<ChevronDown size={15}/></summary><ul className="history">{state.audit.slice(0, 20).map((item: Row) => <li key={item.seq}><span>{auditLabel(item.event)}{item.detail?.target && <small className="technical">{item.detail.target}</small>}</span><time>{date(item.at)}</time></li>)}</ul></details>}
      </div>}
    </main>

    {approval && <div className="modal-backdrop" onClick={() => {if (!busy) setApproval(null);}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title" onClick={event => event.stopPropagation()}>
      <div className="row spread"><h2 id="approval-title">{approval.title}</h2><button className="plain" aria-label="Close approval" disabled={!!busy} onClick={() => setApproval(null)}><X size={18}/></button></div><p className="technical target-name">{approval.target}</p><p>{approval.impact}</p>
      {approval.payload?.settings && <ResolvedSettings settings={approval.payload.settings}/>}
      {approval.cost && <div className="cost"><strong>About {number(approval.cost.monthlyEstimate)} toman / month</strong><p>{approval.cost.assumption}</p></div>}
      <p className="field-note">{approval.rollback}</p><p className="field-note">Proposal expires {date(approval.expires)}</p>
      <form onSubmit={event => {event.preventDefault(); run('execute', async () => {const result = await api('/approvals/' + approval.id + '/execute', 'POST', {confirmation}); if (['deploy', 'create-app'].includes(approval.type)) setJobId(result.id); setApproval(null); if (approval.type === 'deploy') {setStep(3); setPage('deploy');} else if (approval.type === 'create-app') {setStep(2); setDeployTarget(approval.target); setPage('deploy');} });}}>
        <div className="field"><label htmlFor="confirmation">Enter the service name to confirm</label><input id="confirmation" autoFocus dir="ltr" autoComplete="off" placeholder={approval.target} value={confirmation} onChange={event => setConfirmation(event.target.value)}/></div><label className="checkbox"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/><span>I approve this change{approval.cost ? ' and its cost' : ''}.</span></label><button type="submit" className="primary full" disabled={!!busy || !consent || confirmation !== approval.target || approval.expires < Date.now()}>{busy === 'execute' ? <Loader2 size={16} className="spin"/> : <CheckCircle2 size={16}/>}Approve and run</button>
      </form>{message && <p className="notice warning" role="alert">{message}</p>}
    </section></div>}
    {logData && <div className="modal-backdrop" onClick={() => setLogData(null)}><section className="modal logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-title" onClick={event => event.stopPropagation()}><div className="row spread"><h2 id="logs-title">Service logs</h2><button className="plain" aria-label="Close logs" onClick={() => setLogData(null)}><X size={18}/></button></div><pre dir="ltr">{logData.logs?.map((item: Row) => item.line).join('\n') || 'No logs available.'}</pre></section></div>}
  </div>;
}
function auditLabel(event: string) {return ({'approval.requested':'Proposal prepared', 'approval.accepted':'Approval recorded', 'approval.rejected':'Proposal rejected', 'operation.finished':'Operation completed', 'operation.failed':'Operation failed', 'operation.needs_attention':'Verification needed', 'operation.health_verified':'Health checked', 'incident.recovered':'Service recovered', 'connection.updated':'Connection updated', 'connection.disconnected':'Disconnected', 'liara.synced':'Services refreshed', 'incident.investigated':'Investigation completed', 'sandbox.fault_injected':'Demo failure triggered'} as Row)[event] || event;}
createRoot(document.getElementById('root')!).render(<App/>);
