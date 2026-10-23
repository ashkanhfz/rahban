import AdmZip from 'adm-zip';
import tar from 'tar-stream';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
export const sampleFiles={
  'package.json':JSON.stringify({name:'rahban-demo-site',version:'1.0.0',scripts:{start:'node index.js'},engines:{node:'22.x'}},null,2),
  'index.js':`const http = require('node:http');\nhttp.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html lang="fa" dir="rtl"><title>سلام از راه‌بان</title><body style="background:#101820;color:#c5f277;font:24px sans-serif;padding:10vw"><h1>سایت شما آنلاین است.</h1><p>منتشرشده با راه‌بان روی لیارا</p></body></html>');}).listen(process.env.PORT || 3000,'0.0.0.0');\n`,
  '.env.example':'PORT=3000\n',
};
export function unpackZip(buffer){
  const zip=new AdmZip(buffer),entries=zip.getEntries();
  if(entries.length>4000)throw new Error('حداکثر ۴۰۰۰ فایل مجاز است.');
  let total=0;const files=Object.create(null);
  const names=entries.filter(e=>!e.isDirectory).map(e=>e.entryName);
  const root=names.length&&names.every(n=>n.includes('/')&&n.split('/')[0]===names[0].split('/')[0])?names[0].split('/')[0]+'/':'';
  for(const e of entries){
    if(e.isDirectory)continue;
    const raw=e.entryName;if(raw.includes('\\')||raw.startsWith('/')||raw.split('/').includes('..')||raw.includes(':'))throw new Error('مسیر ناامن در آرشیو.');
    if(((e.attr>>>16)&0xf000)===0xa000)throw new Error('لینک نمادین در آرشیو پشتیبانی نمی‌شود.');
    total+=e.header.size;if(total>40*1024*1024||e.header.size>4*1024*1024)throw new Error('حجم بازشدهٔ آرشیو بیش از حد مجاز است.');
    const name=raw.slice(root.length);
    if(/(^|\/)(node_modules|\.git|\.next|dist|\.env(?:\..*)?|.*\.pem|.*\.key|id_rsa)(\/|$)/.test(name)&&!name.endsWith('.env.example'))continue;
    files[name]=e.getData();
  }
  if(!Object.keys(files).length)throw new Error('آرشیو فایل قابل انتشار ندارد.');return files;
}
export function inspect(files){
  const text=n=>files[n]?.toString()||'';let pkg={};
  try{pkg=JSON.parse(text('package.json')||'{}');}catch{throw new Error('package.json معتبر نیست.');}
  const supported=!!files['package.json'];
  const env=[...new Set(Object.entries(files).filter(([n])=>/\.(js|ts|tsx|jsx)$/.test(n)).flatMap(([,s])=>[...s.toString().matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(m=>m[1])))].filter(n=>n!=='PORT'&&n!=='NODE_ENV');
  const checks=[{name:'مسیر پشتیبانی‌شدهٔ Node.js',ok:supported},{name:'دستور شروع مشخص است',ok:!!pkg.scripts?.start},{name:'نسخهٔ Node مشخص است',ok:!!pkg.engines?.node},{name:'فایل‌های شناخته‌شدهٔ اسرار کنار گذاشته شدند',ok:true}];
  const deps=pkg.dependencies||{};const sizing={minMemoryGB:deps.next||deps['@nestjs/core']?1:.5,minCpu:.25};
  return {name:pkg.name||'uploaded-project',platform:supported?'node':'unsupported',fileCount:Object.keys(files).length,env,checks,sizing,ready:supported&&!!pkg.scripts?.start,port:3000,summary:supported?'پروژهٔ Node.js شناسایی شد. پلن اولیه بر اساس فرض نیاز پروژه پیشنهاد می‌شود؛ مصرف واقعی پس از انتشار باید ارزیابی شود.':'این MVP انتشار Node.js را پشتیبانی می‌کند؛ فایل‌ها اجرا نشده‌اند.'};
}
export async function archive(files){
  const pack=tar.pack(),chunks=[];
  const done=new Promise((resolve,reject)=>{pack.on('data',c=>chunks.push(c));pack.on('end',()=>resolve(gzipSync(Buffer.concat(chunks))));pack.on('error',reject);});
  for(const [name,value] of Object.entries(files))pack.entry({name,mode:0o644},Buffer.from(value));pack.finalize();return done;
}
export function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}
