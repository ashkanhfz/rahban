import {writeFileSync} from 'node:fs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:4310');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
  throw new Error('Provide only the application HTTP(S) origin, without credentials.');
}
const report = {
  checkedAt: new Date().toISOString(),
  scope: 'Application health endpoint only',
  origin: base.origin,
  status: 'failed',
  checks: [],
  notRun: ['Liara deployment', 'Paid model request', 'Docker runtime', 'Windows start/stop scripts'],
};
try {
  const response = await fetch(new URL('/healthz', base), {signal: AbortSignal.timeout(5000), redirect: 'error'});
  const body = await response.json();
  const ok = response.ok && body.status === 'ok' && body.service === 'rahban';
  report.status = ok ? 'passed' : 'failed';
  report.checks.push({name: 'GET /healthz identifies Rahban and reports ok', passed: ok, httpStatus: response.status});
} catch {
  report.checks.push({name: 'GET /healthz', passed: false, error: 'No valid application health response within 5 seconds.'});
}
writeFileSync(new URL('../VALIDATION.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
