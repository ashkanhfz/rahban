import AdmZip from 'adm-zip';
import tar from 'tar-stream';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
export const sampleFiles={
  'package.json':JSON.stringify({name:'rahban-demo-site',version:'1.0.0',scripts:{start:'node index.js'},engines:{node:'22.x'}},null,2),
  'index.js':`const http = require('node:http');\nhttp.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html lang="en" dir="ltr"><title>Hello from Rahban</title><body style="background:#101820;color:#c5f277;font:24px sans-serif;padding:10vw"><h1>Your site is online.</h1><p>Deployed with Rahban on Liara</p></body></html>');}).listen(process.env.PORT || 3000,'0.0.0.0');\n`,
  '.env.example':'PORT=3000\n',
  'Dockerfile':'FROM node:22-alpine\nWORKDIR /app\nCOPY package.json index.js ./\nENV PORT=3000\nEXPOSE 3000\nCMD ["node", "index.js"]\n',
};

function detectPort(files){
  const docker=(files.Dockerfile?.toString()||'').split(/^\s*FROM\s+/im).at(-1);
  const example=files['.env.example']?.toString()||'';
  const code=Object.entries(files).filter(([name])=>/\.[cm]?[jt]sx?$/.test(name)).map(([,value])=>value.toString()).join('\n');
  const candidates=[docker.match(/^\s*EXPOSE\s+(\d+)/im)?.[1],example.match(/^\s*PORT\s*=\s*["']?(\d+)/m)?.[1],code.match(/process\.env\.PORT\s*(?:\|\||\?\?)\s*(\d+)/)?.[1],code.match(/\.listen\(\s*(\d+)/)?.[1]];
  const port=candidates.map(Number).find(value=>Number.isInteger(value)&&value>0&&value<=65535);
  return {port:port??3000,portDetected:port!==undefined};
}
export function unpackZip(buffer){
  const zip=new AdmZip(buffer),entries=zip.getEntries();
  if(entries.length>4000)throw new Error('Archive limit is 4,000 files.');
  let total=0;const files=Object.create(null);
  const names=entries.filter(e=>!e.isDirectory).map(e=>e.entryName);
  const root=names.length&&names.every(n=>n.includes('/')&&n.split('/')[0]===names[0].split('/')[0])?names[0].split('/')[0]+'/':'';
  for(const e of entries){
    if(e.isDirectory)continue;
    const raw=e.entryName;if(raw.includes('\\')||raw.startsWith('/')||raw.split('/').includes('..')||raw.includes(':'))throw new Error('Unsafe path in archive.');
    if(((e.attr>>>16)&0xf000)===0xa000)throw new Error('Symbolic links in archives are not supported.');
    total+=e.header.size;if(total>40*1024*1024||e.header.size>4*1024*1024)throw new Error('Unpacked archive exceeds the size limit.');
    const name=raw.slice(root.length);
    if(/(^|\/)(node_modules|\.git|\.env(?:\..*)?|.*\.pem|.*\.key|id_rsa)(\/|$)/.test(name)&&!name.endsWith('.env.example'))continue;
    files[name]=e.getData();
    files[name].archiveMode=(e.attr>>>16)&0o111?0o755:0o644;
  }
  if(!Object.keys(files).length)throw new Error('Archive contains no deployable files.');return files;
}
export function inspect(files){
  const text=n=>files[n]?.toString()||'';let pkg={};
  try{pkg=JSON.parse(text('package.json')||'{}');}catch{throw new Error('Invalid package.json.');}
  const docker=!!files.Dockerfile,platform=docker?'docker':files['package.json']?'node':'unsupported';
  const supported=platform!=='unsupported';
  const references=Object.entries(files).filter(([n])=>/\.[cm]?[jt]sx?$/.test(n)).flatMap(([,value])=>[...value.toString().matchAll(/process\.env\.([A-Z][A-Z0-9_]*)(\s*(?:\|\||\?\?))?/g)]);
  const env=[...new Set(references.map(match=>match[1]))].filter(name=>!['PORT','NODE_ENV'].includes(name));
  const dockerDefaults=new Set([...text('Dockerfile').matchAll(/^\s*ENV\s+([A-Z][A-Z0-9_]*)(?:=|\s)/gm)].map(match=>match[1]));
  const requiredEnv=env.filter(name=>!dockerDefaults.has(name)&&references.some(match=>match[1]===name&&!match[2]));
  const runnable=docker?/^\s*FROM\s+\S+/im.test(text('Dockerfile')):!!pkg.scripts?.start;
  const checks=[{name:docker?'Dockerfile found':'Node.js project found',ok:supported},{name:docker?'Base image specified':'Start command specified',ok:runnable},{name:'Known secret files excluded',ok:true}];
  const deps=pkg.dependencies||{};const sizing={minMemoryGB:deps.next||deps['@nestjs/core']?1:.5,minCpu:.25};
  return {name:pkg.name||'uploaded-project',platform,fileCount:Object.keys(files).length,env,requiredEnv,checks,sizing,ready:supported&&runnable,...detectPort(files),summary:supported?(docker?'Builds using Dockerfile.':'Runs using the Node.js start command.'):'A Dockerfile or package.json is required at the project root.'};
}
export async function archive(files){
  const pack=tar.pack(),chunks=[];
  const done=new Promise((resolve,reject)=>{pack.on('data',c=>chunks.push(c));pack.on('end',()=>resolve(gzipSync(Buffer.concat(chunks))));pack.on('error',reject);});
  for(const [name,value] of Object.entries(files))pack.entry({name,mode:value.archiveMode??(value.toString().startsWith('#!')?0o755:0o644)},Buffer.from(value));pack.finalize();return done;
}
export function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}
