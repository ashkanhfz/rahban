import {useEffect, useRef, useState} from 'react';
import {ChevronDown, GitBranch, Loader2, RefreshCw} from 'lucide-react';
import './continuous.css';

type Row = Record<string, any>;
type Props = {
  service?: Row;
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  run: (label: string, operation: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  onReview: (id: string) => void;
};
const stamp = (value: number|string) => new Date(value).toLocaleString('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
const statuses: Record<string, string> = {disabled:'Off', scheduled:'Scheduled', checking:'Checking', awaiting_approval:'Awaiting approval', deploying:'Deploying', paused:'Paused'};

export function ContinuousDeployment({service, api, run, busy, onReview}: Props) {
  const [saved, setSaved] = useState<Row|null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [enabled, setEnabled] = useState(false), [intervalMinutes, setIntervalMinutes] = useState(5), [mode, setMode] = useState('review'), [confirmation, setConfirmation] = useState('');
  const request = useRef(0);
  const prefix = '/services/' + encodeURIComponent(service?.id || '') + '/continuous';
  const apply = (result: Row) => {setSaved(result); setEnabled(!!result.enabled); setIntervalMinutes(result.intervalMinutes || 5); setMode(result.mode || 'review'); setConfirmation(''); setError('');};
  useEffect(() => {
    const pending = ++request.current;
    setSaved(null); setEnabled(false); setIntervalMinutes(5); setMode('review'); setConfirmation(''); setError('');
    setLoading(!!service?.github);
    if (service?.github) api(prefix).then(result => {if (pending === request.current) apply(result);}).catch(reason => {if (pending === request.current) setError(reason.message);}).finally(() => {if (pending === request.current) setLoading(false);});
    return () => {request.current++;};
  }, [service?.id, service?.accountScope, service?.github?.repo, service?.github?.branch, service?.github?.commit]);
  if (!service?.github) return null;
  const dirty = saved && (enabled !== !!saved.enabled || intervalMinutes !== saved.intervalMinutes || mode !== saved.mode);
  const needsConfirmation = enabled && mode === 'automatic';
  const canSave = !!saved && !loading && !busy && (!enabled || (saved.eligible && (!needsConfirmation || confirmation === service.id)));
  const update = (label: string, operation: () => Promise<Row>) => run(label, async () => {
    const pending = ++request.current; setLoading(true);
    try {const result = await operation(); if (pending === request.current) apply(result);}
    finally {if (pending === request.current) setLoading(false);}
  });
  const refresh = () => update('github-updates', () => api(prefix));
  const save = () => update('github-updates', () => api(prefix, 'POST', {enabled, intervalMinutes, mode, ...(needsConfirmation ? {confirmation} : {})}));
  const check = () => update('github-check', () => api(prefix + '/check', 'POST', {}));
  const github = saved?.github || service.github;

  return <details className="fold github-updates"><summary>GitHub updates<span className="muted">{saved ? statuses[saved.status] || saved.status : ''}</span><ChevronDown size={15}/></summary><div className="fold-content">
    <p className="update-repository"><GitBranch size={15}/><span><strong>{github.repo}</strong><small>{github.branch}{service.github.commit ? ' · Deployed ' + service.github.commit.slice(0, 7) : ''}</small></span></p>
    <p className="field-note">Optional after your first successful deployment. Checks and automatic deployment are off by default. When enabled, pushed commits on this branch are detected at the next scheduled check, not instantly.</p>
    {loading && <p className="request-status" role="status"><Loader2 size={14} className="spin"/>Loading update settings…</p>}
    {error && <p className="notice warning" role="alert">{error} <button className="inline-link" disabled={busy || loading} onClick={refresh}>Retry</button></p>}
    {saved && <>
      {saved.unavailableReason && <p className="notice warning">{saved.unavailableReason}</p>}
      {saved.status === 'paused' && <p className="notice">Updates are paused. Review the latest operation, then enable and save to resume.</p>}
      <form onSubmit={event => {event.preventDefault(); save();}}>
        <div className="update-controls"><label className="checkbox"><input type="checkbox" checked={enabled} disabled={busy || loading || (!saved.eligible && !enabled)} onChange={event => setEnabled(event.target.checked)}/>Check GitHub for new commits</label><div className="field update-interval"><label htmlFor="github-interval">Check every</label><select id="github-interval" value={intervalMinutes} disabled={busy || !enabled} onChange={event => setIntervalMinutes(Number(event.target.value))}>{[1,5,15,60].map(value => <option key={value} value={value}>{value} minute{value > 1 ? 's' : ''}</option>)}</select></div></div>
        <fieldset className="update-modes"><legend className="sr-only">What to do with new commits</legend><label><input type="radio" name="github-update-mode" value="review" checked={mode === 'review'} disabled={busy || !enabled} onChange={() => {setMode('review'); setConfirmation('');}}/><span>Prepare a deployment for review</span></label><label><input type="radio" name="github-update-mode" value="automatic" checked={mode === 'automatic'} disabled={busy || !enabled} onChange={() => setMode('automatic')}/><span>Deploy automatically</span></label></fieldset>
        {needsConfirmation && <div className="update-authorization"><p>Future commits to <bdi>{github.branch}</bdi> will deploy to <bdi>{service.id}</bdi> with its saved runtime settings, without another approval. New code can affect service availability.</p><div className="field"><label htmlFor="github-confirmation">Enter the app name to authorize automatic deployments</label><input id="github-confirmation" autoComplete="off" value={confirmation} placeholder={service.id} onChange={event => setConfirmation(event.target.value)}/></div></div>}
        <div className="row wrap"><button type="submit" disabled={!canSave}>Save update settings</button><button type="button" disabled={busy || loading || !saved.enabled || !!dirty} onClick={check}><RefreshCw size={14}/>Check now</button><button type="button" className="plain" disabled={busy || loading} onClick={refresh}>Refresh status</button></div>
        {dirty && <p className="field-note">Save your changes before checking.</p>}
      </form>
      <p className="field-note">Checks run while Rahban is online and connected. Restarting Rahban or an uncertain deployment pauses updates until you enable them again.</p>
      {saved.pendingApprovalId && saved.status === 'awaiting_approval' && <div className="update-pending"><span>New commit{saved.pendingCommit ? ' ' + saved.pendingCommit.slice(0, 7) : ''} is ready for review.</span><button disabled={busy} onClick={() => onReview(saved.pendingApprovalId)}>Review deployment</button></div>}
      {(saved.lastChecked || saved.nextRun || saved.latestCommit) && <p className="field-note update-status">{saved.lastChecked && <span>Last checked: {stamp(saved.lastChecked)}</span>}{saved.nextRun && <span>Next check: {stamp(saved.nextRun)}</span>}{saved.latestCommit && <span>Latest commit: <bdi>{saved.latestCommit.slice(0, 7)}</bdi></span>}</p>}
      {saved.lastError && <p className="notice warning">{saved.lastError}</p>}
    </>}
  </div></details>;
}
