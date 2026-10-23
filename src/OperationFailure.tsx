import {AlertCircle, AlertTriangle} from 'lucide-react';
import './operation-failure.css';

type Job = Record<string, any>;
const operations: Record<string, string> = {
  'create-app': 'App creation', deploy: 'Deployment', check: 'Service check',
  restart: 'Restart', 'start-app': 'Start service', 'stop-app': 'Stop service',
  'delete-app': 'App deletion', 'update-env': 'Environment update',
};

function recovery(job: Job) {
  if (job.failure?.nextStep) return job.failure.nextStep;
  if (job.status === 'interrupted') return 'Rahban restarted before this operation finished. Check its outcome before starting another operation.';
  if (job.status === 'needs_attention') return job.type === 'check' ? 'Open Investigate service to inspect its status and logs.' : 'Use Verify outcome to check the current state before preparing another operation.';
  const status = job.failure?.status || Number(job.message?.match(/HTTP (\d{3})/)?.[1]);
  if (status === 401) return 'Open Settings and reconnect with a valid Liara API token.';
  if (status === 402) return 'Add credit in the Liara console, then review the operation again.';
  if (status === 403) return 'Check the selected account, team and token permissions in Settings.';
  if (status === 409 && job.type === 'create-app') return 'Choose Edit and retry, enter a different app name, then review creation again.';
  if (status === 429) return 'Wait briefly, refresh the service status, then review another attempt.';
  if (job.releaseFailed) return 'Open Investigate service to inspect the logs. Fix the reported issue, then use Edit and retry.';
  if (job.type === 'create-app') return 'Use Edit and retry to check the app name, plan and network before trying again.';
  if (job.type === 'deploy') return 'Check the failure below, correct the project or deployment settings, then use Edit and retry.';
  return 'Check the service status and logs before preparing another operation.';
}

export function OperationFailure({job}: {job: Job}) {
  const uncertain = job.status !== 'failed';
  const failure = job.failure || {};
  const Icon = uncertain ? AlertTriangle : AlertCircle;
  const title = job.status === 'interrupted' ? 'Operation interrupted' : uncertain ? 'Outcome needs verification' : `${operations[job.type] || 'Operation'} failed`;
  const status = failure.status || Number(job.message?.match(/HTTP (\d{3})/)?.[1]);
  const stage = failure.stage || job.stage;
  const detail = failure.providerMessage && !job.message?.includes(failure.providerMessage) ? failure.providerMessage : '';
  return <section className={`operation-failure${uncertain ? ' uncertain' : ''}`} role="alert" aria-label={title}>
    <div className="failure-heading"><Icon size={19} aria-hidden="true"/><strong>{title}</strong>{!!status && <span className="failure-status">HTTP {status}</span>}</div>
    {stage && <p className="failure-stage">{uncertain ? 'Last stage' : 'Failed during'}: {stage}</p>}
    <p className="failure-reason">{job.message || 'This operation did not finish. Check its current state before trying again.'}</p>
    {detail && <p className="failure-provider"><strong>Liara response</strong>{detail}</p>}
    <p className="failure-recovery"><strong>Next step</strong>{recovery(job)}</p>
    {failure.code && <details className="failure-details"><summary>Error details</summary><p>Error code: <code>{failure.code}</code></p></details>}
  </section>;
}
