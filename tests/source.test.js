import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import {unpackZip,inspect,sampleFiles,archive,digest} from '../server/source.js';
import {diagnose,redact} from '../server/agent.js';
test('public repository root is stripped, credentials and dependencies excluded',()=>{
  const zip=new AdmZip();for(const [name,text]of Object.entries({...sampleFiles,'.env':'TOKEN=secret','node_modules/x.js':'dependency','.git/config':'private'}))zip.addFile('repo-main/'+name,Buffer.from(text));
  const files=unpackZip(zip.toBuffer());assert.ok(files['package.json']);assert.ok(!files['.env']);assert.ok(!files['node_modules/x.js']);assert.ok(!files['.git/config']);assert.equal(inspect(files).ready,true);
});
test('missing start command blocks deployment, env references are found',()=>{
  assert.equal(inspect({'package.json':'{}'}).ready,false);
  assert.deepEqual(inspect({...sampleFiles,'env.js':'process.env.DATABASE_URL; process.env.PORT; process.env.DATABASE_URL'}).env,['DATABASE_URL']);
  assert.throws(()=>inspect({'package.json':'not json'}));
});
test('deployment archive content is immutable by SHA256',async()=>{const bytes=await archive(sampleFiles);assert.ok(bytes.length>100);const hash=digest(bytes);const changed=Buffer.from(bytes);changed[3]^=1;assert.notEqual(hash,digest(changed));});
test('secrets are redacted and evidence distinguishes latency from resource guesses',()=>{
  const redacted=redact('Bearer abcdef API_KEY=private postgres://user:pass@db:5432/a actual-user-token',['actual-user-token']);
  assert.ok(!redacted.includes('private'));assert.ok(!redacted.includes('user:pass'));assert.ok(!redacted.includes('actual-user-token'));
  const results=diagnose([{line:'INFO request completed'}],{ok:0,code:200,ms:1700});assert.match(results[0].evidence,/1700/);assert.ok(!results[0].title.includes('حافظه'));
});
