import {useEffect, useRef, useState} from 'react';

export type Route = {page: 'home'|'deploy'|'job'|'incidents'|'settings'; path: string; step: number; jobId: string; serviceId: string; incidentId: string};
const id = (value: string|null) => value && /^[\w.:-]{1,160}$/.test(value) ? value : '';
export function parseRoute(path: string): Route {
  const fallback: Route = {page:'home', path:'/deployments', step:1, jobId:'', serviceId:'', incidentId:''};
  try {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length === 1 && parts[0] === 'settings') return {...fallback, page:'settings', path:'/settings'};
    if (parts[0] === 'deploy' && parts[1] === 'new' && parts.length === 3 && ['project','destination','review'].includes(parts[2])) {
      const jobId = parts[2] === 'destination' ? id(url.searchParams.get('job')) : '';
      return {...fallback, page:'deploy', step:['project','destination','review'].indexOf(parts[2]) + 1, jobId, path:'/deploy/new/' + parts[2] + (jobId ? '?job=' + encodeURIComponent(jobId) : '')};
    }
    if (parts[0] === 'deployments' && parts.length === 2 && id(parts[1])) return {...fallback, page:'job', jobId:parts[1], path:'/deployments/' + encodeURIComponent(parts[1])};
    if (parts[0] === 'services' && (parts.length === 1 || (parts.length === 2 && id(parts[1])))) {
      const serviceId = parts[1] || '', incidentId = serviceId ? id(url.searchParams.get('incident')) : '';
      return {...fallback, page:'incidents', serviceId, incidentId, path:'/services' + (serviceId ? '/' + encodeURIComponent(serviceId) : '') + (incidentId ? '?incident=' + encodeURIComponent(incidentId) : '')};
    }
  } catch { /* Invalid or unfamiliar URLs return to the deployments list. */ }
  return fallback;
}
export const projectRoute = (step: number) => '/deploy/new/' + (['project','destination','review'][step - 1] || 'project');
export const serviceRoute = (service: string, incident = '') => '/services' + (service ? '/' + encodeURIComponent(service) : '') + (service && incident ? '?incident=' + encodeURIComponent(incident) : '');
export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.href));
  const generation = useRef(0);
  useEffect(() => {
    const read = () => {
      generation.current++;
      const next = parseRoute(window.location.href);
      if (window.location.pathname + window.location.search !== next.path) history.replaceState(history.state, '', next.path);
      setRoute(next);
    };
    read(); window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  const go = (path: string, replace = false) => {
    const next = parseRoute(path), current = parseRoute(window.location.href);
    if (next.path === current.path) return;
    generation.current++;
    const entry = next.page === 'settings' ? {returnTo: current.path, rahbanSettingsEntry: !replace} : {};
    history[replace ? 'replaceState' : 'pushState'](entry, '', next.path);
    setRoute(next); window.scrollTo({top:0});
  };
  const backFromSettings = () => {
    const returnTo = typeof history.state?.returnTo === 'string' && parseRoute(history.state.returnTo).page !== 'settings' ? history.state.returnTo : '/deployments';
    if (history.state?.rahbanSettingsEntry) history.back();
    else go(returnTo, true);
  };
  const captureRoute = () => {
    const version = generation.current, path = window.location.pathname + window.location.search;
    return () => generation.current === version && window.location.pathname + window.location.search === path;
  };
  return {route, go, backFromSettings, captureRoute};
}

export type DeploymentDraft = {
  sourceId: string; sourceType: string; repo: string; branch: string; destinationType: string; deployTarget: string;
  appName: string; planId: string; bundleId: string; networkId: string; port: string; healthPath: string; healthTimeout: string; buildCache: boolean;
};
const draftKey = 'rahban.deployment-draft.v1';
const text = (value: unknown, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';
function cleanDraft(value: Partial<DeploymentDraft>): DeploymentDraft {
  let repo = '';
  try {const url = new URL(text(value.repo, 2048)); if (url.hostname === 'github.com' && ['https:','http:'].includes(url.protocol)) repo = 'https://github.com' + url.pathname;} catch { /* Keep only complete public GitHub URLs. */ }
  const healthPath = text(value.healthPath, 1024).split(/[?#]/)[0];
  return {
    sourceId:id(text(value.sourceId)), sourceType:value.sourceType === 'zip' ? 'zip' : 'github', repo, branch:text(value.branch, 256),
    destinationType:value.destinationType === 'existing' ? 'existing' : 'new', deployTarget:id(text(value.deployTarget)),
    appName:text(value.appName), planId:text(value.planId), bundleId:text(value.bundleId), networkId:text(value.networkId),
    port:text(value.port, 8), healthPath:healthPath.startsWith('/') ? healthPath : '', healthTimeout:text(value.healthTimeout, 8), buildCache:value.buildCache !== false,
  };
}
export function readDraft(): DeploymentDraft|null {
  try {const value = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); return value && typeof value === 'object' && !Array.isArray(value) ? cleanDraft(value) : null;} catch {return null;}
}
export function saveDraft(value: DeploymentDraft) {try {sessionStorage.setItem(draftKey, JSON.stringify(cleanDraft(value)));} catch { /* Storage can be unavailable in private browsers. */ }}
export function clearDraft() {try {sessionStorage.removeItem(draftKey);} catch { /* The in-memory draft can still be cleared. */ }}
