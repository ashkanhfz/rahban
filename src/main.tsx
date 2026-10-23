import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ExternalLink, Eye, EyeOff, FolderArchive, GitBranch, Loader2, LogOut, Plus, RefreshCw, Settings2, Upload, X} from 'lucide-react';
import './styles.css';
import {ServiceTools} from './ServiceTools';
import {ContinuousDeployment} from './ContinuousDeployment';
import {ServiceManagement} from './ServiceManagement';
import {OperationFailure} from './OperationFailure';
import {clearDraft, projectRoute, readDraft, saveDraft, serviceRoute, useRoute} from './navigation';

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
const money = (n: number) => Math.round(Number(n)).toLocaleString('en-US');
const pricedBundles = (plan?: Row) => (plan?.bundles || []).filter((item: Row) => item.monthlyPrice !== null && Number.isFinite(Number(item.monthlyPrice))).sort((a: Row, b: Row) => a.monthlyPrice - b.monthlyPrice);
const featureValue = (value: unknown) => typeof value === 'boolean' ? value ? 'Included' : 'Not included' : String(value);
const featureHelp: Record<string, string> = {
  'Deployments per day': 'Maximum deployments to this app each day.',
  'Custom domains': 'Maximum custom domain names connected to this app. Domain registration is separate.',
  'Rollback': 'Restore an earlier release through Liara. This does not enable automatic rollback in Rahban.',
  'Zero downtime': 'Deploy without planned interruption. When not included, deployment may briefly interrupt requests.',
  'Free SSL': 'HTTPS certificates for connected domains. Correct DNS setup is required.',
};
function CostBreakdown({base, bundle, total}: {base: number; bundle: number; total: number}) {
  return <dl className="cost-breakdown"><div><dt>App resources · 720 hours</dt><dd>{money(base)} toman</dd></div><div><dt>Feature bundle</dt><dd>{money(bundle)} toman</dd></div><div className="cost-total"><dt>Estimated monthly total</dt><dd>{money(total)} toman</dd></div></dl>;
}
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
function Job({job, services, onVerify, onRetry, onInspect, onRemove, busy}: {job: Row, services: Row[], onVerify: (id: string) => void, onRetry: (id: string) => void, onInspect: (target: string) => void, onRemove: (id: string) => void, busy: boolean}) {
  const service = services.find(item => item.id === job.target);
  const site = service?.domain && /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(service.domain) ? `https://${service.domain}` : null;
  const canVerify = job.type !== 'check' && (job.status === 'needs_attention' || (job.status === 'interrupted' && (job.mutationRequested || job.createRequested || job.releaseRequested || job.releaseId)));
  return <article className="job"><div className="row spread"><div><strong>{job.title}</strong><small className="technical">{job.target}</small></div><Badge status={job.status}/></div>
    <ol className="job-steps">{(job.steps || []).map((item: Row, i: number) => <li key={i} className={item.status === 'failed' ? 'warning' : ''}>{item.status === 'failed' ? '!' : '✓'} {item.title}</li>)}</ol>
    {['failed', 'needs_attention', 'interrupted'].includes(job.status) ? <OperationFailure job={job}/> : job.message && <p className="job-message">{job.message}</p>}
    <div className="row wrap">{site && job.type === 'deploy' && job.status === 'succeeded' && <a className="button primary" href={site} target="_blank" rel="noreferrer">Open website<ExternalLink size={15}/></a>}{canVerify && <button disabled={busy} onClick={() => onVerify(job.id)}><RefreshCw size={15}/>Verify outcome</button>}{((job.type === 'create-app' && job.status === 'failed') || (job.type === 'deploy' && ['failed', 'succeeded'].includes(job.status))) && <button disabled={busy} onClick={() => onRetry(job.id)}><RefreshCw size={15}/>{job.status === 'succeeded' ? 'Deploy again' : 'Edit and retry'}</button>}{['deploy', 'check'].includes(job.type) && ['failed', 'needs_attention', 'interrupted'].includes(job.status) && <button disabled={busy} onClick={() => onInspect(job.target)}>Investigate service</button>}<time className="muted">{date(job.created)}</time></div>{['succeeded', 'failed'].includes(job.status) && <button className="plain history-remove" disabled={busy} onClick={() => onRemove(job.id)}>Remove from history</button>}
  </article>;
}

function App() {
  const {route, go, backFromSettings, captureRoute} = useRoute();
  const [draft] = useState(readDraft);
  const page = route.page, step = route.step, jobId = route.jobId;
  const [state, setState] = useState<Row|null>(null), [online, setOnline] = useState(true);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [failedAction, setFailedAction] = useState('');
  const [source, setSource] = useState<Row|null>(null), [sourceId, setSourceId] = useState(draft?.sourceId || ''), [repo, setRepo] = useState(draft?.repo || ''), [branch, setBranch] = useState(draft?.branch || '');
  const [sourceType, setSourceType] = useState(draft?.sourceType || 'github'), [destinationType, setDestinationType] = useState(draft?.destinationType || 'new');
  const [restoringSource, setRestoringSource] = useState(false), [sourceError, setSourceError] = useState(''), [restoreAttempt, setRestoreAttempt] = useState(0);
  const [loadedJob, setLoadedJob] = useState<Row|null>(null), [jobError, setJobError] = useState(''), [jobAttempt, setJobAttempt] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false), [previewError, setPreviewError] = useState(''), [previewAttempt, setPreviewAttempt] = useState(0);
  const [practice, setPractice] = useState(false), [showToken, setShowToken] = useState(false), [showModelKey, setShowModelKey] = useState(false), [loadingPlans, setLoadingPlans] = useState(false);
  const sourceRequest = useRef(0);
  const stateRequest = useRef(0), latestState = useRef<Row|null>(null), context = useRef('');
  context.current = [state?.mode, state?.settings?.team, state?.settings?.connectionId, state?.runtime?.bootId].join(':');
  const captureView = () => {const onRoute = captureRoute(), account = context.current; return () => onRoute() && account === context.current;};
  const jobInState = !!state?.jobs?.some((item: Row) => item.id === jobId);
  const bootId = useRef(''), selectedCreateJob = useRef(''), [recovered, setRecovered] = useState(false);
  const uploadFile = useRef<File|null>(null), destinationIntent = useRef<string|null>(draft?.destinationType || null), retryPlan = useRef<Row|null>(null);
  const selected = route.serviceId || (state?.services || []).find((item: Row) => practice || item.mode === 'live')?.id || '', selectedIncident = route.incidentId;
  const [deployTarget, setDeployTarget] = useState(draft?.deployTarget || ''), [preview, setPreview] = useState<Row|null>(null);
  const [port, setPort] = useState(draft?.port || ''), [healthPath, setHealthPath] = useState(draft?.healthPath || ''), [healthTimeout, setHealthTimeout] = useState(draft?.healthTimeout || ''), [buildCache, setBuildCache] = useState(draft?.buildCache ?? true);
  const [plans, setPlans] = useState<Row|null>(null), [planId, setPlanId] = useState(draft?.planId || ''), [bundleId, setBundleId] = useState(draft?.bundleId || ''), [appName, setAppName] = useState(draft?.appName || ''), [networkId, setNetworkId] = useState(draft?.networkId || '');
  const [approval, setApproval] = useState<Row|null>(null), [confirmation, setConfirmation] = useState(''), [consent, setConsent] = useState(false);
  const [prompt, setPrompt] = useState(''), [logData, setLogData] = useState<Row|null>(null);
  const [token, setToken] = useState(''), [team, setTeam] = useState(''), [modelBase, setModelBase] = useState(''), [modelKey, setModelKey] = useState(''), [modelName, setModelName] = useState(''), [share, setShare] = useState(false);
  const load = async () => {
    const request = ++stateRequest.current;
    try {
      const previousSession = sessionGeneration;
      const next = await api('/state');
      if (request !== stateRequest.current) return latestState.current || next;
      if (next.runtime?.bootId) {
        if (bootId.current && bootId.current !== next.runtime.bootId) {if (sessionGeneration === previousSession) await renewSession(); if (request !== stateRequest.current) return latestState.current || next; setRecovered(true); setApproval(null);}
        bootId.current = next.runtime.bootId;
      }
      latestState.current = next; setState(next); setOnline(true); return next;
    } catch (error) {if (request === stateRequest.current) setOnline(false); throw error;}
  };
  const run = async (label: string, operation: () => Promise<unknown>) => { if (busy) return; const current = captureView(); setBusy(label); setMessage(''); setFailedAction(''); try { await operation(); await load(); } catch (error) {if (current()) {setMessage((error as Error).message); setFailedAction(label);}} finally { setBusy(''); } };
  const acceptPlans = (result: Row) => {
    const catalog: Row[] = result.catalog || [];
    const preferred = retryPlan.current || {planID: planId, bundlePlanID: bundleId, network: networkId};
    const plan = catalog.find(item => item.planID === preferred.planID) || catalog.find(item => item.planID === result.recommendation?.planID && item.selectable) || catalog.filter(item => item.selectable).sort((a, b) => (a.monthlyBase + pricedBundles(a)[0]?.monthlyPrice) - (b.monthlyBase + pricedBundles(b)[0]?.monthlyPrice))[0];
    const available = pricedBundles(plan);
    const bundle = available.find((item: Row) => item.bundlePlanID === preferred.bundlePlanID) || available.find((item: Row) => item.bundlePlanID === result.recommendation?.bundlePlanID) || available[0];
    const networks: Row[] = result.networks || [];
    setPlans(result); setPlanId(plan?.planID || ''); setBundleId(bundle?.bundlePlanID || '');
    setNetworkId(networks.some(item => item._id === preferred.network) ? preferred.network : networks.length === 1 ? networks[0]._id : '');
    retryPlan.current = null;
  };
  const refreshPlans = () => run('plans', async () => {const current = captureView(); setLoadingPlans(true); try {const result = await api('/plans' + (source ? '?sourceId=' + source.id : '')); if (current()) acceptPlans(result);} finally {setLoadingPlans(false);}});
  useEffect(() => { renewSession().then(load).catch(error => setMessage(error.message)); const timer = setInterval(() => load().catch(() => {}), 4000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (state?.settings) { setTeam(state.settings.team || ''); setModelBase(state.settings.llmBase || ''); setModelName(state.settings.llmModel || ''); setShare(!!state.settings.shareEvidence); } }, [state?.settings?.team, state?.settings?.llmBase, state?.settings?.llmModel, state?.settings?.shareEvidence]);
  useEffect(() => {
    if (!state || destinationIntent.current || !source) return;
    const destinations = (state?.services || []).filter((item: Row) => item.mode === 'live' && item.platform === source.platform);
    if (!destinations.some((item: Row) => item.id === deployTarget)) setDeployTarget(destinations[0]?.id || '');
    destinationIntent.current = destinations.length ? 'existing' : 'new';
    setDestinationType(destinationIntent.current);
  }, [state?.services?.map((item: Row) => item.id + item.platform).join(','), state?.mode, source?.platform]);
  useEffect(() => {
    saveDraft({sourceId, sourceType, repo, branch, destinationType, deployTarget, appName, planId, bundleId, networkId, port, healthPath, healthTimeout, buildCache});
  }, [sourceId, sourceType, repo, branch, destinationType, deployTarget, appName, planId, bundleId, networkId, port, healthPath, healthTimeout, buildCache]);
  useEffect(() => {
    setApproval(null); setConfirmation(''); setConsent(false); setLogData(null); setMessage('');
  }, [route.path]);
  useEffect(() => {
    if (!state || !sourceId || source?.id === sourceId) {setRestoringSource(false); return;}
    let active = true; const request = ++sourceRequest.current; setRestoringSource(true); setSourceError('');
    const current = () => active && request === sourceRequest.current;
    api('/sources/' + encodeURIComponent(sourceId)).then(result => {if (current()) setSource(result);}).catch(error => {if (current()) setSourceError(error.message);}).finally(() => {if (current()) setRestoringSource(false);});
    return () => {active = false;};
  }, [!!state, sourceId, restoreAttempt]);
  useEffect(() => {
    setLoadedJob(null); setJobError('');
    if (!state || !jobId || jobInState) return;
    let active = true;
    api('/jobs/' + encodeURIComponent(jobId)).then(result => {if (active) setLoadedJob(result);}).catch(error => {if (active) setJobError(error.message);});
    return () => {active = false;};
  }, [!!state, jobId, jobInState, state?.mode, state?.settings?.connected, state?.settings?.team, state?.settings?.connectionId, state?.runtime?.bootId, jobAttempt]);
  useEffect(() => {
    const job = (state?.jobs || []).find((item: Row) => item.id === jobId) || loadedJob;
    const created = job?.id === jobId && job.type === 'create-app' && job.status === 'succeeded' ? job : null;
    if (created && selectedCreateJob.current !== created.id && (state?.services || []).some((service: Row) => service.id === created.target)) {selectedCreateJob.current = created.id; destinationIntent.current = 'existing'; setDeployTarget(created.target); setDestinationType('existing');}
  }, [jobId, state?.jobs, state?.services, loadedJob]);
  useEffect(() => {
    if (page !== 'deploy' || step !== 2 || destinationType !== 'new' || state?.mode !== 'live' || plans || (sourceId && !source)) return;
    let active = true; setLoadingPlans(true);
    api('/plans' + (source ? '?sourceId=' + source.id : '')).then(result => {if (active) {acceptPlans(result); setLoadingPlans(false);}}).catch(error => {if (active) {setMessage(error.message); setFailedAction('plans'); setLoadingPlans(false);}});
    return () => {active = false;};
  }, [page, step, destinationType, state?.mode, source?.id, plans, state?.settings?.connectionId, state?.runtime?.bootId]);
  useEffect(() => {setPlans(null); setLoadedJob(null); setPreview(null); setApproval(null); setConfirmation(''); setConsent(false);}, [state?.mode, state?.settings?.team, state?.settings?.connectionId, state?.runtime?.bootId]);
  useEffect(() => {
    setPreview(null); setPreviewError('');
    if (page !== 'deploy' || step !== 3 || !source?.ready || !deployTarget || state?.mode !== 'live') {setPreviewLoading(false); return;}
    let active = true; setPreviewLoading(true);
    Promise.resolve().then(() => api('/deployment/preview', 'POST', {sourceId:source.id, settings:readSettings()})).then(result => {if (active) setPreview(result);}).catch(error => {if (active) setPreviewError(error.message);}).finally(() => {if (active) setPreviewLoading(false);});
    return () => {active = false;};
  }, [page, step, source?.id, deployTarget, port, healthPath, healthTimeout, buildCache, state?.mode, state?.settings?.team, state?.settings?.connectionId, state?.runtime?.bootId, previewAttempt]);
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
  const navigate = (next: string) => go(next === 'settings' ? '/settings' : next === 'incidents' ? serviceRoute(selected) : '/deployments');
  const goStep = (next: number) => go(projectRoute(next));
  const acceptSource = (next: Row) => {sourceRequest.current++; destinationIntent.current = null; setSource(next); setSourceId(next.id); setSourceError(''); setPreview(null); setPort(''); setHealthPath(''); setHealthTimeout(''); setBuildCache(true); setPlans(null);};
  const clearSource = () => {sourceRequest.current++; setSource(null); setSourceId(''); setSourceError('');};
  const newDeployment = () => {clearDraft(); destinationIntent.current = null; retryPlan.current = null; uploadFile.current = null; setNetworkId(''); setFailedAction(''); clearSource(); setSourceType('github'); setDestinationType('new'); setRepo(''); setBranch(''); setDeployTarget(''); setPort(''); setHealthPath(''); setHealthTimeout(''); setBuildCache(true); setPreview(null); setPlans(null); setPlanId(''); setBundleId(''); setAppName(''); goStep(1);};
  const chooseDestination = (value: string) => {destinationIntent.current = value; setDestinationType(value);};
  const importGithub = () => run('github', async () => {const current = captureView(); clearSource(); const request = sourceRequest.current; const result = await api('/sources/github', 'POST', {url: repo.trim(), branch: branch.trim() || undefined}); if (current() && request === sourceRequest.current) acceptSource(result);});
  const importArchive = (file: File) => run('upload', async () => {const current = captureView(); uploadFile.current = file; clearSource(); const request = sourceRequest.current; const data = new FormData(); data.append('file', file); const result = await api('/sources/upload', 'POST', data); if (current() && request === sourceRequest.current) acceptSource(result);});
  const importSample = () => run('sample', async () => {const current = captureView(); clearSource(); const request = sourceRequest.current; const result = await api('/sources/sample', 'POST', {}); if (current() && request === sourceRequest.current) acceptSource(result);});
  const retryJob = (id: string) => run('retry', async () => {
    const current = captureView();
    const draft = await api('/jobs/' + id + '/retry');
    if (!current()) return;
    const saved = draft.source, settings = draft.settings || {};
    sourceRequest.current++; setSource(saved); setSourceId(saved?.id || ''); setSourceError(''); setSourceType(saved?.github ? 'github' : 'zip'); setRepo(saved?.github?.repo ? 'https://github.com/' + saved.github.repo.replace(/^https:\/\/github\.com\//, '') : ''); setBranch(saved?.github?.branch || '');
    setPort(settings.port == null ? '' : String(settings.port)); setHealthPath(settings.healthPath || ''); setHealthTimeout(settings.healthTimeoutMs == null ? '' : String(settings.healthTimeoutMs)); setBuildCache(settings.buildCache ?? true);
    setPlans(null); setPreview(null); setApproval(null); uploadFile.current = null;
    if (draft.type === 'create-app') {retryPlan.current = draft.create; setAppName(draft.create.name); setPlanId(draft.create.planID || ''); setBundleId(draft.create.bundlePlanID || ''); setNetworkId(draft.create.network || ''); chooseDestination('new');}
    else {retryPlan.current = null; setDeployTarget(draft.target); chooseDestination('existing');}
    goStep(saved?.ready ? 2 : 1); setMessage('Draft restored. Review the settings before requesting a new approval.');
  });
  const inspectJob = (target: string) => go(serviceRoute(target));
  const reviewPending = (id: string) => run('review', async () => {const current = captureView(); const next = await load(); if (!current()) return; const item = next.approvals.find((row: Row) => row.id === id && row.status === 'pending'); if (!item) throw new Error('This approval is no longer pending. Refresh GitHub update status.'); openApproval(item);});
  const openJob = (id: string) => {const item = state?.jobs?.find((row: Row) => row.id === id); go(item?.type === 'check' && item.incidentId ? serviceRoute(item.target, item.incidentId) : '/deployments/' + encodeURIComponent(id));};
  const removeHistory = (id: string) => {if (!window.confirm('Only removes this entry from Rahban history. The app keeps running. Continue?')) return; run('remove-history', async () => {const current = captureView(); await api('/jobs/' + encodeURIComponent(id), 'DELETE'); if (current() && jobId === id) navigate('home');});};
  const openApproval = (item: Row) => {setApproval(item); setConfirmation(''); setConsent(false);};
  const propose = async (type: string, target: string, extras: Row = {}) => {const current = captureView(); const result = await api('/proposals', 'POST', {type, target, ...extras}); if (current()) openApproval(result);};
  const readSettings = (): DeploySettings => {
    const numeric = (value: string, label: string) => { if (!value.trim()) return null; const parsed = Number(value); if (!Number.isInteger(parsed)) throw new Error(`${label} must be a whole number.`); return parsed; };
    return {port: numeric(port, 'Port'), healthPath: healthPath.trim() || null, healthTimeoutMs: numeric(healthTimeout, 'Response timeout'), buildCache};
  };
  const review = () => goStep(3);
  const investigate = () => run('investigate', async () => {const current = captureView(); const result = await api('/incidents', 'POST', {target: selected, message: prompt || 'Check service health'}); if (current()) {go(serviceRoute(selected, result.id)); setPrompt('');}});
  const showLogs = (target: string) => run('logs', async () => {const current = captureView(); const result = await api('/logs/' + target); if (current()) setLogData(result);});
  const verify = (id: string) => run('verify', async () => {const current = captureView(); await api('/jobs/' + id + '/verify', 'POST', {}); const result = await api('/jobs/' + id); if (current()) setLoadedJob(result);});
  const switchMode = (mode: string) => run('mode', async () => {await api('/mode', 'POST', {mode}); setPractice(mode === 'demo'); if (mode === 'live') await api('/sync', 'POST', {}); setApproval(null);});
  if (!state) return <main className="boot"><h1>Rahban</h1><p><Loader2 size={16} className="spin"/>Connecting…</p>{message && <div role="alert"><p>{message}</p><button onClick={() => window.location.reload()}>Retry</button></div>}</main>;

  const live = state.mode === 'live', services: Row[] = (state.services || []).filter((item: Row) => practice || item.mode === 'live'), jobs: Row[] = (state.jobs || []).filter((item: Row) => practice || (item.mode !== 'demo' && item.target !== 'sandbox-store')), incidents: Row[] = live || practice ? state.incidents || [] : [];
  const pending: Row[] = (state.approvals || []).filter((item: Row) => item.status === 'pending' && (live || practice));
  const destinations = services.filter(item => item.mode === 'live' && item.platform === (source?.platform || 'node'));
  const serviceIncidents = incidents.filter(item => item.target === selected);
  const incident = selectedIncident ? serviceIncidents.find(item => item.id === selectedIncident) : serviceIncidents[0];
  const currentJob = jobs.find(item => item.id === jobId) || (loadedJob?.id === jobId ? loadedJob : null);
  const last = (state.probes || []).filter((item: Row) => item.service === selected).at(-1);
  const options: Row[] = plans?.catalog || [];
  const selectedPlan = options.find(item => item.planID === planId), bundles: Row[] = pricedBundles(selectedPlan), selectedBundle = bundles.find(item => item.bundlePlanID === bundleId);
  const networks: Row[]|null = plans?.networks ?? null, networkRequired = networks !== null && (networks.length === 0 || (networks.length > 1 && !networkId));
  const titles: Row = {home: 'Deployments', deploy: 'New deployment', job: currentJob?.type === 'deploy' ? 'Deployment details' : 'Operation details', incidents: 'Check service', settings: 'Settings'};
  const deployments = jobs.filter(item => item.type === 'deploy');
  const monthlyEstimate = selectedPlan?.monthlyBase != null && selectedBundle ? Number(selectedPlan.monthlyBase) + Number(selectedBundle.monthlyPrice) : null;
  const needsReview = (item: Row) => item.type !== 'check' && item.mode !== 'demo' && item.target !== 'sandbox-store' && ['running', 'needs_attention', 'interrupted'].includes(item.status);
  const otherJobs = jobs.filter(item => item.id !== currentJob?.id || page !== 'job').sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)));

  return <div className="app">
    <header className="header"><button className="brand" onClick={() => navigate('home')}><span className="brand-mark" aria-hidden="true">r</span>Rahban</button><nav aria-label="Pages"><button aria-current={['home', 'deploy', 'job'].includes(page) ? 'page' : undefined} onClick={() => navigate('home')}>Deployments</button><button aria-current={page === 'incidents' ? 'page' : undefined} onClick={() => navigate('incidents')}>Check service</button></nav><div className="header-end"><button aria-label="Settings" className={'plain ' + (page === 'settings' ? 'active' : '')} onClick={() => navigate('settings')}><Settings2 size={16}/><span>Settings</span></button>{state.hosting?.public && <form action="/auth/logout" method="post"><button className="plain" type="submit" aria-label="Sign out"><LogOut size={15}/><span>Sign out</span></button></form>}</div></header>
    <div className={'layout ' + (page === 'settings' ? 'settings-layout' : '')}><main className="main">
      {page === 'settings' && <button className="plain back-link" onClick={backFromSettings}><ArrowLeft size={15}/>Back</button>}
      {(page === 'deploy' || page === 'job') && <button className="plain back-link" onClick={() => navigate('home')}><ArrowLeft size={15}/>Deployments</button>}
      <div className="page-title"><h1>{titles[page]}</h1>{page === 'home' && deployments.length > 0 ? <button className="primary" disabled={!!busy} onClick={newDeployment}><Plus size={16}/>New deployment</button> : live ? <span className="environment live"><span aria-hidden="true"/>Liara connected</span> : practice ? <span className="environment">Practice mode</span> : null}</div>
      {page !== 'settings' && !state.settings.connected && !practice && <p className="connection-note warning" role="alert">Add your Liara API token in <button className="inline-link" onClick={() => navigate('settings')}>Settings</button> to deploy.</p>}
      {recovered && <div className="notice message" role="status"><span>Rahban restarted. Review interrupted operations before retrying.</span><button className="plain" aria-label="Dismiss recovery notice" onClick={() => setRecovered(false)}><X size={16}/></button></div>}
      {!online && <p className="notice warning" role="alert">Connection lost. Displayed information may be outdated. <button className="plain" disabled={!!busy} onClick={() => run('refresh', load)}>Retry</button></p>}
      {message && <div className="notice message" role="alert"><span>{message}</span><button className="plain" aria-label="Dismiss message" onClick={() => setMessage('')}><X size={16}/></button></div>}
      {busy && <p className="request-status" role="status"><Loader2 size={14} className="spin"/>{busy === 'preview' ? 'Checking settings…' : busy === 'upload' || busy === 'github' ? 'Inspecting project…' : 'Working…'}</p>}


      {page === 'deploy' && restoringSource && <p className="request-status" role="status"><Loader2 size={14} className="spin"/>Restoring project…</p>}
      {page === 'deploy' && sourceError && <div className="notice warning" role="alert"><p>The saved project could not be restored. {sourceError} Your other draft fields are kept.</p><div className="row wrap"><button disabled={restoringSource} onClick={() => setRestoreAttempt(value => value + 1)}>Retry restore</button><button className="plain" onClick={() => goStep(1)}>Reimport project</button></div></div>}
      {page === 'deploy' && step > 1 && !sourceId && !source && <p className="notice warning">Choose a project before continuing. <button className="inline-link" onClick={() => goStep(1)}>Choose project</button></p>}

      {page === 'home' && <section className={'workspace ' + (!deployments.length ? 'empty-state' : 'deployment-list')}>
        {!deployments.length ? <><FolderArchive size={31} strokeWidth={1.5}/><h2>No deployments yet</h2><p className="muted">Choose a project from GitHub or upload a ZIP file.</p><button className="primary" disabled={!!busy} onClick={newDeployment}><Plus size={16}/>New deployment</button></> : deployments.map(item => <button className="deployment-row" key={item.id} onClick={() => openJob(item.id)}><span><strong className="technical">{item.target}</strong><small>{date(item.created)}</small></span><Badge status={item.status}/><ArrowRight size={16}/></button>)}
      </section>}
      {page === 'job' && <section className="workspace">{currentJob ? <><Job job={currentJob} services={services} onVerify={verify} onRetry={retryJob} onInspect={inspectJob} onRemove={removeHistory} busy={!!busy}/>{live && currentJob.type === 'deploy' && <ContinuousDeployment service={services.find(item => item.id === currentJob.target)} api={api} run={run} busy={!!busy} onReview={reviewPending}/>}<div className="step-actions"><button disabled={!!busy} onClick={newDeployment}><Plus size={15}/>New deployment</button></div></> : jobError ? <div className="notice warning" role="alert"><p>{jobError}</p><button disabled={!!busy} onClick={() => setJobAttempt(value => value + 1)}>Retry loading operation</button></div> : <p className="muted">Loading operation…</p>}</section>}

      {page === 'deploy' && <>
        <ol className="steps" aria-label="Deployment steps">{['Project', 'Destination', 'Review'].map((label, i) => <li key={label} className={step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''}><button disabled={!!busy || i + 1 > step} aria-current={step === i + 1 ? 'step' : undefined} onClick={() => goStep(i + 1)}><span>{step > i + 1 ? <Check size={13}/> : number(i + 1)}</span>{label}</button></li>)}</ol>
        <section className="workspace" aria-label={['', 'Choose project', 'Choose destination', 'Review deployment'][step]}>
          {step === 1 && <>
            <h2>Project source</h2>
            <fieldset className="segmented" disabled={!!busy}><legend className="sr-only">Project source</legend><label className={sourceType === 'github' ? 'selected' : ''}><input type="radio" name="source-type" value="github" checked={sourceType === 'github'} onChange={() => {setSourceType('github'); clearSource();}}/><GitBranch size={16}/>GitHub</label><label className={sourceType === 'zip' ? 'selected' : ''}><input type="radio" name="source-type" value="zip" checked={sourceType === 'zip'} onChange={() => {setSourceType('zip'); clearSource();}}/><Upload size={16}/>ZIP file</label></fieldset>
            {sourceType === 'github' ? <form onSubmit={event => {event.preventDefault(); importGithub();}}><div className="field"><label htmlFor="repo">Public repository URL</label><input id="repo" disabled={!!busy} type="url" dir="ltr" placeholder="https://github.com/you/project" value={repo} onChange={event => setRepo(event.target.value)} required/></div><div className="field"><label htmlFor="branch">Branch</label><input id="branch" disabled={!!busy} dir="ltr" placeholder="Default branch (automatic)" value={branch} onChange={event => setBranch(event.target.value)}/></div><button disabled={!!busy || !repo.trim()} type="submit">{failedAction === 'github' ? 'Retry import' : 'Import and inspect'}</button><p className="field-note">After your first successful deployment, you can enable checks for pushed commits under GitHub updates. Automatic deployment is off by default.</p></form> : <div className="source-upload"><FolderArchive size={28} strokeWidth={1.5} aria-hidden="true"/><div><strong>Project archive</strong><p className="muted">ZIP file, up to 10 MB</p></div><div className="source-actions"><label className={'button file-button ' + (busy ? 'disabled' : '')}><Upload size={16}/>Choose ZIP file<input aria-label="Choose ZIP file" type="file" accept=".zip" disabled={!!busy} onChange={event => {const file = event.target.files?.[0]; event.target.value = ''; if (file) importArchive(file);}}/></label><button className="plain" disabled={!!busy} onClick={importSample}>Use sample project</button></div></div>}
            {failedAction === 'upload' && uploadFile.current && <p className="field-note">{uploadFile.current.name} <button className="inline-link" disabled={!!busy} onClick={() => uploadFile.current && importArchive(uploadFile.current)}>Retry upload</button></p>}
            {source && <div className="source-result"><div className="row spread"><strong className="technical">{source.name || source.label}</strong><span className="source-kind"><bdi>{source.platform === 'docker' ? 'Docker' : source.platform === 'node' ? 'Node.js' : 'Unsupported project'}</bdi> · {number(source.fileCount)} files</span></div>{source.github && <p className="field-note repository"><GitBranch size={14}/><span>{source.github.repo} · {source.github.branch}{source.github.commit ? ' · ' + source.github.commit.slice(0, 7) : ''}</span></p>}<Checks items={(source.checks || []).filter((item: Row) => !item.ok)}/>{source.ready && <p className="source-ready"><CheckCircle2 size={15}/>Project inspected</p>}<details className="fold"><summary>Inspection details<ChevronDown size={15}/></summary><Checks items={source.checks || []}/></details>{!source.ready && source.summary && <p className="notice warning">{source.summary}</p>}{!!(source.requiredEnv ?? source.env ?? []).length && <p className="notice">Set <bdi>{(source.requiredEnv ?? source.env ?? []).join(', ')}</bdi> in your app’s environment variables in the <a href="https://console.liara.ir" target="_blank" rel="noreferrer">Liara console</a>. Save, then return here before deployment.</p>}</div>}
            <div className="step-actions"><button className="primary" disabled={!!busy || !source?.ready} onClick={() => goStep(2)}>Continue<ArrowRight size={16}/></button></div>
          </>}
          {step === 2 && <>
            <h2>Deployment destination</h2>
            {!live ? <div className="connect-note"><p>{state.settings.connected ? 'Switch to Liara to continue.' : 'Connect your Liara account in Settings to continue.'}</p>{state.settings.connected ? <button className="primary" disabled={!!busy} onClick={() => switchMode('live')}>Use Liara</button> : <button onClick={() => navigate('settings')}>Open Settings</button>}</div> : <>
              <fieldset className="segmented" disabled={!!busy}><legend className="sr-only">Destination</legend><label className={destinationType === 'new' ? 'selected' : ''}><input type="radio" name="destination-type" checked={destinationType === 'new'} onChange={() => chooseDestination('new')}/>New app</label><label className={destinationType === 'existing' ? 'selected' : ''}><input type="radio" name="destination-type" checked={destinationType === 'existing'} onChange={() => chooseDestination('existing')}/>Existing app</label></fieldset>
              {destinationType === 'existing' ? <div className="field">{destinations.length ? <><label htmlFor="deploy-service">App</label><div className="input-row"><ServiceSelect id="deploy-service" services={destinations} value={deployTarget} onChange={setDeployTarget}/><button aria-label="Refresh services" disabled={!!busy} onClick={() => run('sync', () => api('/sync', 'POST', {}))}><RefreshCw size={16}/></button></div></> : <p className="field-note">No compatible apps. <button className="inline-link" onClick={() => chooseDestination('new')}>Create a new app</button></p>}</div> : <>
                <div className="field"><label htmlFor="app-name">App name</label><input id="app-name" dir="ltr" placeholder="my-app" value={appName} onChange={event => setAppName(event.target.value)} aria-describedby="app-name-help"/><p id="app-name-help" className="field-note">Use a unique name with lowercase letters, numbers and hyphens. This becomes your app address.</p></div>
                {loadingPlans ? <p className="request-status"><Loader2 size={14} className="spin"/>Loading plans…</p> : plans ? <>
                  {selectedPlan && <div className="plan-summary"><div className="row spread"><strong>{selectedPlan.planID}</strong><span className="muted">{bundleId || 'No bundle selected'}</span></div><dl className="plan-resources"><div><dt>CPU{selectedPlan.cpuShared ? ' · shared' : ''}</dt><dd>{selectedPlan.cpu == null ? 'Not provided' : number(selectedPlan.cpu) + (Number(selectedPlan.cpu) === 1 ? ' core' : ' cores')}</dd></div><div><dt>RAM</dt><dd>{selectedPlan.memoryGB == null ? 'Not provided' : number(selectedPlan.memoryGB) + ' GB'}</dd></div><div><dt>Disk</dt><dd>{selectedPlan.diskGB == null ? 'Not provided' : number(selectedPlan.diskGB) + ' GB'}</dd></div></dl>
                    {monthlyEstimate !== null ? <CostBreakdown base={selectedPlan.monthlyBase} bundle={selectedBundle!.monthlyPrice} total={monthlyEstimate}/> : <p className="warning">{selectedPlan.unavailableReason || 'No priced bundle is available. Choose another plan.'}</p>}
                    <p>Starter estimate. Actual resource usage has not been measured.</p>
                  </div>}
                  {!options.some(item => item.selectable) && <p className="notice warning">No deployable plans are available for this account. Refresh plans or check availability in the Liara console.</p>}
                  <details className="fold" open={!selectedPlan?.selectable || !selectedBundle ? true : undefined}><summary>{selectedPlan?.selectable && selectedBundle ? 'Change plan' : 'Choose a plan and bundle'}<ChevronDown size={15}/></summary><div className="fold-content"><div className="field"><label htmlFor="plan">Plan</label><select id="plan" value={planId} onChange={event => {const next = options.find(item => item.planID === event.target.value); setPlanId(event.target.value); setBundleId(pricedBundles(next)[0]?.bundlePlanID || '');}}><option value="">Select a plan</option>{options.map(item => <option key={item.planID} value={item.planID} disabled={!item.selectable}>{item.planID}{item.memoryGB != null ? ' · ' + number(item.memoryGB) + ' GB RAM' : ''}{item.cpu != null ? ' · ' + number(item.cpu) + ' CPU' : ''}{!item.selectable ? ' · Unavailable' : ''}</option>)}</select></div>
                    {bundles.length ? <div className="field"><label htmlFor="bundle">Feature bundle</label><select id="bundle" value={bundleId} onChange={event => setBundleId(event.target.value)}>{bundles.map(item => <option key={item.bundlePlanID} value={item.bundlePlanID}>{item.bundlePlanID} · {money(item.monthlyPrice)} toman / month</option>)}</select></div> : null}
                    {selectedBundle && ((selectedBundle.features || []).length ? <dl className="bundle-features bundle-feature-list">{selectedBundle.features.map((feature: Row) => <div key={feature.name}><dt>{feature.name}{featureHelp[feature.name] && <small className="feature-help">{featureHelp[feature.name]}</small>}</dt><dd>{featureValue(feature.value)}</dd></div>)}</dl> : <p className="field-note">Liara did not provide feature details for this bundle.</p>)}
                  </div></details>
                  {networks && networks.length > 1 && <div className="field"><label htmlFor="network">Private network</label><select id="network" value={networkId} onChange={event => setNetworkId(event.target.value)}><option value="">Select a network</option>{networks.map(item => <option key={item._id} value={item._id}>{item.name || item._id}</option>)}</select><p className="field-note">Groups apps and databases for internal communication. Choose an existing network; it cannot be changed after app creation.</p></div>}
                  {networks?.length === 1 && <p className="field-note">Private network: <strong>{networks[0].name || networks[0]._id}</strong>. Your existing network will be used.</p>}
                  {networks?.length === 0 && <div className="notice warning"><p>Liara returned no networks for {state.settings.team ? 'the selected team' : 'your personal account'}.</p><p><button className="inline-link" disabled={!!busy} onClick={() => navigate('settings')}>Check account and team</button> or <button className="inline-link" disabled={!!busy} onClick={refreshPlans}>Refresh networks</button> first. You can reuse an existing network.</p><p>Only if this account has no network: open Create app → Private network in the <a href="https://console.liara.ir" target="_blank" rel="noreferrer">Liara console</a>, create one, then refresh. <a href="https://docs.liara.ir/paas/details/private-network/" target="_blank" rel="noreferrer">Network setup guide</a></p></div>}
                  {plans.networkWarning && <p className="field-note">{plans.networkWarning}</p>}
                  <p className="field-note">App creation starts billing. Actual charges depend on usage. <a href="https://console.liara.ir" target="_blank" rel="noreferrer">Liara console</a> · <button className="inline-link" disabled={!!busy} onClick={refreshPlans}>Refresh plans</button></p>
                </> : <button disabled={!!busy} onClick={refreshPlans}><RefreshCw size={15}/>Retry loading plans</button>}
              </>}
            </>}
            {destinationType === 'existing' && deployTarget && !destinations.some(item => item.id === deployTarget) && <p className="notice warning">The saved destination <bdi>{deployTarget}</bdi> is not available in this account. Select a compatible app.</p>}
            <details className="fold advanced"><summary>Runtime settings <span className="muted">Port {port || source?.port || 3000}</span><ChevronDown size={15}/></summary><div className="fold-content"><p className="field-note">Leave fields empty to use the defaults.</p><div className="field-grid">
              <div className="field"><label htmlFor="port">App port</label><input id="port" type="number" min="1" max="65535" dir="ltr" placeholder={String(source?.port || 3000)} value={port} onChange={event => setPort(event.target.value)}/><p className="field-note">{source?.port ? 'Detected from your project.' : 'Defaults to 3000.'} Must match the port your app listens on.</p></div>
              <div className="field"><label htmlFor="health-path">Health check path</label><input id="health-path" dir="ltr" placeholder="/" value={healthPath} onChange={event => setHealthPath(event.target.value)}/><p className="field-note">Rahban opens this path after deployment to check that the app responds. Use /health if available; otherwise leave it empty for /.</p></div>
              <div className="field"><label htmlFor="health-timeout">Response timeout (ms)</label><input id="health-timeout" type="number" min="1000" max="30000" dir="ltr" placeholder="5000" value={healthTimeout} onChange={event => setHealthTimeout(event.target.value)}/></div>
              <label className="checkbox cache-option"><input id="build-cache" type="checkbox" checked={buildCache} onChange={event => setBuildCache(event.target.checked)}/><span>Use build cache</span></label>
            </div></div></details>
            {preview && !preview.ready && <Checks items={preview.checks || []}/>}
            <div className="step-actions">{live && destinationType === 'new' ? <button className="primary" disabled={!!busy || restoringSource || !source?.ready || loadingPlans || currentJob?.status === 'running' || !appName.trim() || !selectedPlan?.selectable || !selectedBundle || networkRequired} onClick={() => run('create', () => propose('create-app', appName.trim(), {planID: planId, bundlePlanID: bundleId, platform: source?.platform || 'node', ...(networkId ? {network: networkId} : {}), sourceId: source?.id, settings: readSettings()}))}>Continue · review cost<ArrowRight size={16}/></button> : <button className="primary" disabled={!!busy || !live || !source?.ready || !destinations.some(item => item.id === deployTarget)} onClick={review}>Review deployment<ArrowRight size={16}/></button>}<button className="plain" disabled={!!busy} onClick={() => goStep(1)}>Back</button></div>
          </>}
          {step === 3 && !currentJob && <>
            <h2>Review deployment</h2><dl className="facts identity"><div><dt>Project</dt><dd className="technical">{source?.name || source?.label}</dd></div><div><dt>Destination service</dt><dd className="technical">{deployTarget}</dd></div></dl>
            {previewLoading && <p className="request-status" role="status"><Loader2 size={14} className="spin"/>Checking settings…</p>}
            {previewError && <p className="notice warning" role="alert">{previewError} <button className="inline-link" onClick={() => setPreviewAttempt(value => value + 1)}>Retry settings check</button></p>}
            {!destinations.some(item => item.id === deployTarget) && <p className="notice warning">Select an available destination before requesting approval.</p>}
            {source && !source.ready && <p className="notice warning">This project needs changes before deployment. Return to Project to review the inspection.</p>}
            {preview && <><ResolvedSettings settings={preview.settings}/><p className="field-note">These settings will be used. Empty fields have been filled with defaults.</p><details className="fold"><summary>Project checks<ChevronDown size={15}/></summary><Checks items={preview.checks || []}/></details></>}
            <div className="step-actions"><button className="primary" disabled={!!busy || previewLoading || !source?.ready || !preview?.ready || !live || !destinations.some(item => item.id === deployTarget)} onClick={() => run('propose', () => propose('deploy', deployTarget, {sourceId: source?.id, settings: preview?.settings}))}>Approve deployment<ArrowRight size={16}/></button><button className="plain" disabled={!!busy} onClick={() => goStep(2)}>Edit settings</button></div>
          </>}
          {step === 3 && currentJob && <><h2>Deployment result</h2><Job job={currentJob} services={services} onVerify={verify} onRetry={retryJob} onInspect={inspectJob} onRemove={removeHistory} busy={!!busy}/>{currentJob.status !== 'running' && <button className="plain" onClick={() => goStep(1)}>Deploy again</button>}</>}
          {step === 2 && jobId && !currentJob && jobError && <p className="notice warning" role="alert">{jobError} <button className="inline-link" onClick={() => setJobAttempt(value => value + 1)}>Retry loading operation</button></p>}
          {step === 2 && currentJob?.type === 'create-app' && <Job job={currentJob} services={services} onVerify={verify} onRetry={retryJob} onInspect={inspectJob} onRemove={removeHistory} busy={!!busy}/>}
        </section>
      </>}

      {page === 'incidents' && <section className="workspace">{!live && !practice ? <p className="muted">Connect Liara in <button className="inline-link" onClick={() => navigate('settings')}>Settings</button> to check a service.</p> : <>
        {route.serviceId && !services.some(item => item.id === selected) && <p className="notice warning" role="alert">This service is not available in the current account. Select another service.</p>}
        {selectedIncident && !incident && <p className="notice warning">This investigation is unavailable. You can investigate the service again.</p>}
        <form onSubmit={event => {event.preventDefault(); investigate();}}><div className="field"><label htmlFor="inspect-service">Service</label><ServiceSelect id="inspect-service" services={services} value={selected} onChange={id => go(serviceRoute(id))}/></div>
          {last && <p className="service-status">{Date.now() - last.at > 20000 ? 'Last check' : last.ok ? 'Healthy response' : 'Needs attention'} · <bdi>HTTP {last.code || '—'}</bdi> · {number(last.ms)} ms</p>}
          <div className="field"><label htmlFor="problem">What is wrong? <span className="muted">optional</span></label><input id="problem" placeholder="For example: the site returns HTTP 500" value={prompt} maxLength={2000} onChange={event => setPrompt(event.target.value)}/></div><div className="row wrap"><button className="primary" type="submit" disabled={!!busy || !services.some(item => item.id === selected)}>Investigate</button><button type="button" disabled={!!busy || !services.some(item => item.id === selected)} onClick={() => showLogs(selected)}>View logs</button></div>
        </form>
        {live && <ServiceTools service={services.find(item => item.id === selected)} api={api} run={run} busy={!!busy} onChecked={id => go(serviceRoute(selected, id))}/>}
        {live && <ServiceManagement service={services.find(item => item.id === selected)} api={api} run={run} busy={!!busy} onPropose={propose}/>}
        {incident && <article className="incident"><div className="row spread"><h2>{incident.title}</h2><Badge status={incident.status}/></div><p className="field-note"><bdi>{incident.target}</bdi> · {date(incident.created)}</p>
          {(incident.hypotheses || []).map((item: Row, i: number) => <div className="finding" key={i}><h3>{item.rank ?? i + 1}. {item.title}</h3>{item.confidence != null && <p className="field-note">{String(item.confidence)}</p>}<p>{item.next}</p><details><summary>Evidence</summary><pre dir="ltr">{item.evidence}</pre></details></div>)}
          {incident.metrics && <details className="fold"><summary>Resource evidence<ChevronDown size={15}/></summary><dl className="bundle-features">{[['cpu', 'CPU'], ['memory', 'RAM']].map(([key, label]) => {const metric = incident.metrics[key]; return <div key={key}><dt>{label}</dt><dd>{metric?.status === 'available' && metric.samples?.length ? metric.samples.map((sample: Row) => number(sample.value)).join(' / ') + (metric.unit ? ' ' + metric.unit : ' · API unit not supplied') : metric?.reason || 'Unavailable'}</dd></div>;})}</dl></details>}
          {incident.advice && <p className="advice">{incident.advice}</p>}{incident.modelError && <p className="notice warning">{incident.modelError}</p>}{incident.limitation && <p className="field-note">{incident.limitation}</p>}
          {incident.status === 'resolved' ? <p className="notice success">{incident.resolution}</p> : incident.status !== 'observed' && <details className="fold"><summary>Recovery options <span className="muted">optional</span><ChevronDown size={15}/></summary><div className="fold-content"><p className="field-note">Review the evidence and fix configuration errors first. A restart alone does not correct missing settings.</p><div className="row wrap"><button disabled={!!busy} onClick={() => showLogs(incident.target)}>View logs</button><button disabled={!!busy} onClick={() => run('repair', () => propose(live ? 'restart' : 'restore-demo', incident.target))}>{live ? 'Review restart' : 'Review recovery'}</button></div></div></details>}
          <a className="report-link" href={'/api/incidents/' + incident.id + '/report'} download>Download report</a>
        </article>}
        {serviceIncidents.length > 1 && <details className="fold"><summary>Previous investigations<ChevronDown size={15}/></summary><div className="compact-list">{serviceIncidents.map(item => <button className="list-row" key={item.id} onClick={() => go(serviceRoute(selected, item.id))}><span>{item.title}<small>{item.target}</small></span><Badge status={item.status}/></button>)}</div></details>}
        {!live && <details className="fold"><summary>Test a failure<ChevronDown size={15}/></summary><div className="fold-content"><p className="field-note">Only the local demo service is affected.</p><div className="row wrap"><button disabled={!!busy} onClick={() => run('fault', async () => {await api('/demo/fault', 'POST', {type: 'error'}); await api('/probe/sandbox-store', 'POST', {});})}>Trigger HTTP 503</button><button disabled={!!busy} onClick={() => run('fault', async () => {await api('/demo/fault', 'POST', {type: 'slow'}); await api('/probe/sandbox-store', 'POST', {});})}>Simulate slow response</button></div></div></details>}
      </>}</section>}

      {page === 'settings' && <section className="workspace">
        <h2>Connect to Liara</h2><p className="muted">{state.settings.connected ? 'Account connected.' : 'Get your API token from the Liara console.'} <a href="https://console.liara.ir" target="_blank" rel="noreferrer">Open console<ExternalLink size={12}/></a></p>
        <form onSubmit={event => {event.preventDefault(); const suppliedToken = token; run('connect', async () => {const current = captureRoute(); await api('/settings', 'POST', {...(suppliedToken ? {token: suppliedToken} : {}), team}); await api('/mode', 'POST', {mode: 'live'}); await api('/sync', 'POST', {}); setToken(''); setShowToken(false); setMessage('Connected.'); setPractice(false); if (current()) backFromSettings();});}}>
          <div className="field"><label htmlFor="liara-token">Liara API token</label><div className="password-input"><input id="liara-token" type={showToken ? 'text' : 'password'} autoComplete="off" dir="ltr" value={token} onChange={event => setToken(event.target.value)} placeholder={state.settings.connected ? 'Enter a new token to replace the current one' : ''}/><button type="button" aria-label={showToken ? 'Hide Liara token' : 'Show Liara token'} onClick={() => setShowToken(!showToken)}>{showToken ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></div>
          <details className="fold"><summary>Team account<ChevronDown size={15}/></summary><div className="fold-content field"><label htmlFor="team-id">Team ID <span className="muted">optional</span></label><input id="team-id" dir="ltr" value={team} onChange={event => setTeam(event.target.value)}/><p className="field-note">Only for a Liara team workspace. Leave blank for a personal account.</p></div></details>
          <p className="field-note">The key is not saved in the browser. You may need to reconnect after a server restart.</p><div className="row wrap"><button type="submit" className="primary" disabled={!!busy || (!token && !state.settings.connected)}>{failedAction === 'connect' ? 'Retry connection' : 'Connect and continue'}</button>{state.settings.connected && <button type="button" className="plain" disabled={!!busy} onClick={() => run('disconnect', () => api('/disconnect', 'POST', {}))}>Disconnect</button>}</div>
        </form>
        <details className="fold"><summary>Analysis model <span className="muted">optional</span><ChevronDown size={15}/></summary><form className="fold-content" onSubmit={event => {event.preventDefault(); const suppliedKey = modelKey; run('model', async () => {await api('/settings', 'POST', {llmBase: modelBase, llmModel: modelName, ...(suppliedKey ? {llmKey: suppliedKey} : {}), shareEvidence: share}); setModelKey(''); setShowModelKey(false); setMessage('Model settings saved.');});}}>
          <p className="field-note">Optional for troubleshooting. Not needed to deploy.</p><div className="field"><label htmlFor="model-base">API URL</label><input id="model-base" type="url" dir="ltr" placeholder="https://provider.example/v1" value={modelBase} onChange={event => setModelBase(event.target.value)}/></div><div className="field"><label htmlFor="model-name">Model name</label><input id="model-name" dir="ltr" value={modelName} onChange={event => setModelName(event.target.value)}/></div><div className="field"><label htmlFor="model-key">API key</label><div className="password-input"><input id="model-key" type={showModelKey ? 'text' : 'password'} autoComplete="off" dir="ltr" value={modelKey} onChange={event => setModelKey(event.target.value)}/><button type="button" aria-label={showModelKey ? 'Hide model key' : 'Show model key'} onClick={() => setShowModelKey(!showModelKey)}>{showModelKey ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></div><label className="checkbox"><input type="checkbox" checked={share} onChange={event => setShare(event.target.checked)}/><span>Send the request and error evidence to this provider for analysis. Logs may still contain sensitive data.</span></label><button type="submit" disabled={!!busy || !modelBase || !modelName}>{failedAction === 'model' ? 'Retry save' : 'Save model'}</button>
        </form></details>
        {state.runtime && <details className="fold"><summary>Runtime information<ChevronDown size={15}/></summary><dl className="facts runtime"><div><dt>Instance</dt><dd className="technical">{state.runtime.instanceId}</dd></div><div><dt>Started</dt><dd>{date(state.runtime.startedAt)}</dd></div><div><dt>Boot</dt><dd className="technical">{state.runtime.bootId}</dd></div><div><dt>Recovery</dt><dd>{state.runtime.recovered ? 'Restored from saved state' : 'First start'}</dd></div></dl></details>}
        <details className="fold"><summary>Practice mode<ChevronDown size={15}/></summary><div className="fold-content"><p className="field-note">Inspect projects and practice troubleshooting without deploying to Liara.</p><div className="row wrap"><button disabled={!!busy} onClick={() => {if (!practice) switchMode('demo'); else if (state.settings.connected) switchMode('live'); else setPractice(false);}}>{practice ? 'Leave practice mode' : 'Enable practice mode'}</button>{state.settings.connected && <button disabled={!!busy || live} onClick={() => switchMode('live')}>Use Liara</button>}</div></div></details>
      </section>}

    </main>
    {page !== 'settings' && <aside className="activity-sidebar" aria-label="Activity"><h2>Activity</h2>
      {pending.length > 0 && <details className="fold" open><summary>Awaiting approval <span className="count">{number(pending.length)}</span><ChevronDown size={15}/></summary>{pending.map(item => <div className="activity-item" key={item.id}><strong>{item.title}</strong><small className="technical">{item.target}</small><div className="row"><button disabled={!!busy} onClick={() => openApproval(item)}>Review</button><button className="plain" disabled={!!busy} onClick={() => run('reject', () => api('/approvals/' + item.id + '/reject', 'POST', {}))}>Reject</button></div></div>)}</details>}
      {otherJobs.length > 0 && <details className="fold" open><summary>Recent operations<ChevronDown size={15}/></summary>{(showAllActivity ? otherJobs : otherJobs.slice(0, 6)).map(item => <div key={item.id}><button className="activity-item activity-button" onClick={() => openJob(item.id)}><strong>{item.title}</strong><small className="technical">{item.target}</small><span className="row"><Badge status={item.status}/><time>{date(item.created)}</time></span></button>{['succeeded', 'failed'].includes(item.status) && <button className="plain history-remove" aria-label={'Remove ' + item.title + ' from history'} disabled={!!busy} onClick={() => removeHistory(item.id)}>Remove from history</button>}</div>)}{otherJobs.length > 6 && <button className="plain" aria-expanded={showAllActivity} onClick={() => setShowAllActivity(value => !value)}>{showAllActivity ? 'Show less' : `Show more (${number(otherJobs.length - 6)})`}</button>}</details>}
      {(state.audit || []).length > 0 && <details className="fold"><summary>History<ChevronDown size={15}/></summary><ul className="history">{state.audit.slice(0, 15).map((item: Row) => <li key={item.seq}><span>{auditLabel(item.event)}{item.detail?.target && <small className="technical">{item.detail.target}</small>}</span><time>{date(item.at)}</time></li>)}</ul></details>}
      {!pending.length && !otherJobs.length && !(state.audit || []).length && <p className="muted">No recent activity.</p>}
    </aside>}</div>

    {approval && <div className="modal-backdrop" onClick={() => {if (!busy) setApproval(null);}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title" onClick={event => event.stopPropagation()}>
      <div className="row spread"><h2 id="approval-title">{approval.title}</h2><button className="plain" aria-label="Close approval" disabled={!!busy} onClick={() => setApproval(null)}><X size={18}/></button></div><p className="technical target-name">{approval.target}</p><p>{approval.impact}</p>
      {approval.type === 'update-env' && <div className="notice">{approval.payload?.updatedKeys?.length > 0 && <p>Set: <bdi>{approval.payload.updatedKeys.join(', ')}</bdi></p>}{approval.payload?.removedKeys?.length > 0 && <p>Remove: <bdi>{approval.payload.removedKeys.join(', ')}</bdi></p>}<p className="field-note">Values stay hidden. This change may restart the app.</p></div>}
      {approval.payload?.settings && <ResolvedSettings settings={approval.payload.settings}/>}
      {approval.cost && <div className="cost">{approval.cost.monthlyBase != null && approval.cost.bundleMonthly != null ? <CostBreakdown base={approval.cost.monthlyBase} bundle={approval.cost.bundleMonthly} total={approval.cost.monthlyEstimate}/> : <strong>About {money(approval.cost.monthlyEstimate)} toman / month</strong>}<p>{approval.cost.assumption}</p></div>}
      <p className="field-note">{approval.rollback}</p><p className="field-note">Proposal expires {date(approval.expires)}</p>
      <form onSubmit={event => {event.preventDefault(); run('execute', async () => {const current = captureView(); const result = await api('/approvals/' + approval.id + '/execute', 'POST', {confirmation}); if (!current()) return; setApproval(null); if (approval.type === 'create-app') {setDeployTarget(approval.target); go(projectRoute(2) + '?job=' + encodeURIComponent(result.id));} else if (['deploy', 'update-env', 'delete-app', 'start-app', 'stop-app', 'restart'].includes(approval.type)) go('/deployments/' + encodeURIComponent(result.id)); });}}>
        <div className="field"><label htmlFor="confirmation">Enter the service name to confirm</label><input id="confirmation" autoFocus dir="ltr" autoComplete="off" placeholder={approval.target} value={confirmation} onChange={event => setConfirmation(event.target.value)}/></div><label className="checkbox"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/><span>I approve this change{approval.cost ? ' and its cost' : ''}.</span></label><button type="submit" className="primary full" disabled={!!busy || !consent || confirmation !== approval.target || approval.expires < Date.now()}>{busy === 'execute' ? <Loader2 size={16} className="spin"/> : <CheckCircle2 size={16}/>}Approve and run</button>
      </form>{message && <p className="notice warning" role="alert">{message}</p>}
    </section></div>}
    {logData && <div className="modal-backdrop" onClick={() => setLogData(null)}><section className="modal logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-title" onClick={event => event.stopPropagation()}><div className="row spread"><h2 id="logs-title">Service logs</h2><button className="plain" aria-label="Close logs" onClick={() => setLogData(null)}><X size={18}/></button></div><pre dir="ltr">{logData.logs?.map((item: Row) => item.line).join('\n') || 'No logs available.'}</pre></section></div>}
  </div>;
}
function auditLabel(event: string) {return ({'approval.requested':'Proposal prepared', 'approval.accepted':'Approval recorded', 'approval.rejected':'Proposal rejected', 'operation.finished':'Operation completed', 'operation.failed':'Operation failed', 'operation.needs_attention':'Verification needed', 'operation.health_verified':'Health checked', 'incident.recovered':'Service recovered', 'connection.updated':'Connection updated', 'connection.disconnected':'Disconnected', 'liara.synced':'Services refreshed', 'incident.investigated':'Investigation completed', 'history.removed':'Removed from history', 'monitor.updated':'Health checks updated', 'monitor.checked':'Service checked', 'continuous.updated':'GitHub updates changed', 'continuous.prepared':'GitHub deployment prepared', 'continuous.paused':'GitHub updates paused', 'sandbox.fault_injected':'Practice failure triggered'} as Row)[event] || event;}
createRoot(document.getElementById('root')!).render(<App/>);
