import {useEffect, useRef, useState} from 'react';
import {ChevronDown, ExternalLink, Eye, EyeOff, Plus, RefreshCw, Trash2, X} from 'lucide-react';
import './service-management.css';

type Row = Record<string, any>;
type Props = {
  service?: Row;
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  run: (label: string, operation: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  onPropose: (type: string, target: string, extras?: Row) => Promise<unknown>;
};
const emptyRow = () => ({key:'', value:''});

export function ServiceManagement({service, api, run, busy, onPropose}: Props) {
  const [configuration, setConfiguration] = useState<Row|null>(null), [rows, setRows] = useState([emptyRow()]), [remove, setRemove] = useState<string[]>([]), [visible, setVisible] = useState(false);
  const current = useRef(''); current.current = (service?.accountScope || '') + ':' + (service?.id || '');
  const clear = () => {setRows([emptyRow()]); setRemove([]); setVisible(false);};
  useEffect(() => {setConfiguration(null); clear();}, [service?.id, service?.accountScope]);
  if (!service) return null;
  const keys: string[] = configuration?.envKeys || [];
  const updates = rows.filter(row => row.key.trim()).map(row => ({key:row.key.trim(), value:row.value}));
  const invalid = updates.some(row => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key));
  const duplicate = new Set(updates.map(row => row.key)).size !== updates.length;
  const overlap = updates.some(row => remove.includes(row.key));
  const problem = invalid ? 'Use letters, numbers, and underscores. Start with a letter or underscore.' : duplicate ? 'Each variable name must appear only once.' : overlap ? 'A variable cannot be updated and removed in the same change.' : '';
  const load = () => run('configuration', async () => {const captured = current.current; const result = await api('/services/' + encodeURIComponent(service.id) + '/configuration'); if (captured === current.current) setConfiguration(result);});
  const propose = (type: string) => run(type, () => onPropose(type, service.id));
  const update = (index: number, field: 'key'|'value', value: string) => setRows(current => current.map((row, i) => i === index ? {...row, [field]:value} : row));
  const submit = () => run('environment', async () => {await onPropose('update-env', service.id, {changes:{updates, remove}}); clear();});

  return <div className="service-management">
    <details className="fold" onToggle={event => {if (!event.currentTarget.open) clear();}}><summary>Environment variables<ChevronDown size={15}/></summary><div className="fold-content">
      <div className="row spread wrap"><p className="field-note">Read variable names, then add, replace, or remove values.</p><button disabled={busy} onClick={load}><RefreshCw size={14}/>{configuration ? 'Refresh names' : 'Load names'}</button></div>
      {configuration && <>
        {keys.length ? <fieldset className="environment-keys"><legend>Current variables <span className="muted">select to remove</span></legend>{keys.map(key => <label className="checkbox" key={key}><input type="checkbox" checked={remove.includes(key)} disabled={busy} onChange={event => setRemove(current => event.target.checked ? [...current, key] : current.filter(item => item !== key))}/><code>{key}</code></label>)}</fieldset> : <p className="field-note">No environment variables are set.</p>}
        <form onSubmit={event => {event.preventDefault(); submit();}}>
          <div className="row spread"><h3>Add or update</h3><button type="button" className="plain" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide environment values' : 'Show environment values'}>{visible ? <EyeOff size={15}/> : <Eye size={15}/>}<span>{visible ? 'Hide values' : 'Show values'}</span></button></div>
          {rows.map((row, index) => <div className="environment-row" key={index}><div className="field"><label htmlFor={'env-key-' + index}>Variable name</label><input id={'env-key-' + index} value={row.key} autoComplete="off" maxLength={128} spellCheck={false} placeholder="DATABASE_URL" disabled={busy} onChange={event => update(index, 'key', event.target.value)}/></div><div className="field"><label htmlFor={'env-value-' + index}>New value</label><input id={'env-value-' + index} type={visible ? 'text' : 'password'} value={row.value} autoComplete="new-password" maxLength={16000} spellCheck={false} disabled={busy} onChange={event => update(index, 'value', event.target.value)}/></div><button type="button" className="plain remove-env-row" aria-label={'Remove variable row ' + (index + 1)} disabled={busy} onClick={() => setRows(current => current.length === 1 ? [emptyRow()] : current.filter((_, i) => i !== index))}><X size={16}/></button></div>)}
          <button type="button" className="plain" disabled={busy || rows.length >= 100} onClick={() => setRows(current => [...current, emptyRow()])}><Plus size={14}/>Add variable</button>
          <p className="field-note">Existing values are never shown. An empty new value sets an empty string. New values are cleared after preparing the change or closing this section.</p>
          {problem && <p className="notice warning" role="alert">{problem}</p>}
          <p className="notice warning">Saving environment changes can restart the app and briefly interrupt requests. Review the variable names before approving.</p>
          <button type="submit" disabled={busy || !!problem || (!updates.length && !remove.length)}>Review environment changes</button>
        </form>
      </>}
    </div></details>
    <details className="fold"><summary>Manage app<ChevronDown size={15}/></summary><div className="fold-content">
      <p className="field-note">Start, stop, and restart each require approval. Stopping the app makes its website unavailable.</p>
      <div className="row wrap"><button disabled={busy} onClick={() => propose('restart')}>Review restart</button><button disabled={busy} onClick={() => propose('start-app')}>Start app</button><button disabled={busy} onClick={() => propose('stop-app')}>Stop app</button><a className="button" href="https://console.liara.ir" target="_blank" rel="noreferrer">Liara console<ExternalLink size={13}/></a></div>
      <details className="danger-zone"><summary>Delete app<ChevronDown size={14}/></summary><p>Permanently deletes this Liara app and stops its website. App data may be lost. Other Liara resources are separate and may remain billable.</p>{configuration?.hasDisks && <p>This app has attached disks. Review and back up its data in Liara before deletion.</p>}{configuration?.hasDisks == null && <p>Attached storage has not been confirmed. Check the Liara console and back up any app data before deletion.</p>}<button className="danger-button" disabled={busy} onClick={() => propose('delete-app')}><Trash2 size={14}/>Review app deletion</button></details>
    </div></details>
  </div>;
}
