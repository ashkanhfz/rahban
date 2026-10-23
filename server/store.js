import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
export function openStore(dir){
  mkdirSync(dir,{recursive:true});
  const db=new DatabaseSync(`${dir}/rahban.sqlite`);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL, expires INTEGER NOT NULL, context TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, body TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS probes(id INTEGER PRIMARY KEY, service TEXT, at INTEGER, ok INTEGER, ms REAL, code INTEGER);
  `);
  if(!db.prepare('PRAGMA table_info(probes)').all().some(c=>c.name==='mode'))db.exec("ALTER TABLE probes ADD COLUMN mode TEXT NOT NULL DEFAULT 'demo'");
  if(!db.prepare('PRAGMA table_info(probes)').all().some(c=>c.name==='accountScope'))db.exec('ALTER TABLE probes ADD COLUMN accountScope TEXT');
  for(const old of db.prepare("SELECT * FROM records WHERE kind='service'").all()){const row=JSON.parse(old.body),key=row.mode+':'+row.id;if(old.id!==key){db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(key,'service',old.body,old.created);db.prepare('DELETE FROM records WHERE id=?').run(old.id);}}
  const put=(kind,body)=>{const row={...body,id:body.id||randomUUID(),created:body.created||new Date().toISOString()};const key=kind==='service'?row.mode+':'+row.id:row.id;db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?,?)').run(key,kind,JSON.stringify(row),row.created);return row;};
  const list=kind=>db.prepare('SELECT body FROM records WHERE kind=? ORDER BY created DESC LIMIT 100').all(kind).map(r=>JSON.parse(r.body));
  const get=(kind,id,mode)=>{if(kind==='service'&&!mode)throw new Error('Service environment is required');const key=kind==='service'?mode+':'+id:id;const r=db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,key);return r?JSON.parse(r.body):null;};
  function audit(event,detail){const prev=db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get()?.hash||'GENESIS';const body=JSON.stringify({event,detail,at:new Date().toISOString()});const hash=createHash('sha256').update(prev+body).digest('hex');db.prepare('INSERT INTO audit(body,prev,hash) VALUES(?,?,?)').run(body,prev,hash);}
  return {db,put,list,get,audit};
}
