import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import tar from 'tar-stream';
import {gunzipSync} from 'node:zlib';
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
test('Dockerfile projects work without package.json and infer a configurable exposed port',()=>{
  const info=inspect({'Dockerfile':'FROM python:3.12-slim\nEXPOSE 8080\nCMD ["python", "app.py"]','app.py':'print("hello")'});
  assert.equal(info.platform,'docker');assert.equal(info.ready,true);assert.equal(info.port,8080);assert.equal(info.portDetected,true);
  assert.equal(inspect({'Dockerfile':'EXPOSE 8080'}).ready,false);
  const node=inspect({'package.json':JSON.stringify({scripts:{start:'node index.js'}}),'index.js':'server.listen(process.env.PORT || 4000)'});
  assert.equal(node.platform,'node');assert.equal(node.port,4000);
  assert.equal(inspect({'package.json':JSON.stringify({scripts:{start:'node index.js'}})}).port,3000);
});
test('Docker build context retains prebuilt dist and Next.js files',()=>{
  const zip=new AdmZip();
  for(const [name,text]of Object.entries({'Dockerfile':'FROM nginx:alpine\nCOPY dist /usr/share/nginx/html','dist/index.html':'<h1>Ready</h1>','.next/standalone/server.js':'console.log("ready")'}))zip.addFile('project/'+name,Buffer.from(text));
  const files=unpackZip(zip.toBuffer());
  assert.equal(files['dist/index.html']?.toString(),'<h1>Ready</h1>');
  assert.equal(files['.next/standalone/server.js']?.toString(),'console.log("ready")');
});
test('deployment archive preserves executable permission from the uploaded ZIP',async()=>{
  const zip=new AdmZip();
  zip.addFile('Dockerfile',Buffer.from('FROM alpine\nCOPY entrypoint /entrypoint\nENTRYPOINT ["/entrypoint"]'));
  zip.addFile('entrypoint',Buffer.from('executable-content'),'',0o755);
  zip.addFile('config.json',Buffer.from('{}'),'',0o644);
  const bytes=await archive(unpackZip(zip.toBuffer())),extract=tar.extract(),modes={};
  const done=new Promise((resolve,reject)=>{
    extract.on('entry',(header,stream,next)=>{modes[header.name]=header.mode;stream.on('end',next);stream.resume();});
    extract.on('finish',resolve);extract.on('error',reject);
  });
  extract.end(gunzipSync(bytes));await done;
  assert.equal(modes.entrypoint&0o777,0o755);
  assert.equal(modes['config.json']&0o777,0o644);
});
test('Docker port detection uses the final stage instead of the build stage',()=>{
  const info=inspect({'Dockerfile':'FROM node:22-alpine AS build\nEXPOSE 3000\nRUN echo building\nFROM nginx:alpine\nEXPOSE 8080\nCOPY --from=build /app/dist /usr/share/nginx/html'});
  assert.equal(info.port,8080);assert.equal(info.portDetected,true);
});
test('environment defaults remain informative without becoming required settings',()=>{
  const info=inspect({'Dockerfile':'FROM node:22-alpine\nENV APP_NAME=demo\nCMD ["node", "app.js"]','app.js':'const a=process.env.APP_NAME; const b=process.env.LOG_LEVEL || "info"; const c=process.env.RETRIES ?? 3; const d=process.env.DATABASE_URL;'});
  assert.deepEqual(info.env,['APP_NAME','LOG_LEVEL','RETRIES','DATABASE_URL']);
  assert.deepEqual(info.requiredEnv,['DATABASE_URL']);
});
test('deployment archive content is immutable by SHA256',async()=>{const bytes=await archive(sampleFiles);assert.ok(bytes.length>100);const hash=digest(bytes);const changed=Buffer.from(bytes);changed[3]^=1;assert.notEqual(hash,digest(changed));});
test('secrets are redacted and evidence distinguishes latency from resource guesses',()=>{
  const redacted=redact('Bearer abcdef API_KEY=private postgres://user:pass@db:5432/a actual-user-token',['actual-user-token']);
  assert.ok(!redacted.includes('private'));assert.ok(!redacted.includes('user:pass'));assert.ok(!redacted.includes('actual-user-token'));
  const results=diagnose([{line:'INFO request completed'}],{ok:0,code:200,ms:1700});assert.match(results[0].evidence,/1700/);assert.ok(!results[0].title.includes('memory'));
});
test('sizing states its source heuristic rather than claiming measured resource needs',()=>{
  const generic=inspect(sampleFiles).sizing;
  assert.equal(generic.minMemoryGB,.5);assert.equal(generic.minCpu,.25);assert.match(generic.basis,/No runtime measurements/);
  const next=inspect({'package.json':JSON.stringify({scripts:{start:'next start'},devDependencies:{next:'15'}})}).sizing;
  assert.equal(next.minMemoryGB,1);assert.match(next.basis,/Next.js appears in package.json/);
  const docker=inspect({Dockerfile:'FROM eclipse-temurin:21'}).sizing;
  assert.match(docker.basis,/Docker images may need more/);
});
