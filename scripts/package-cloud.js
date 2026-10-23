// Build a private deploy artifact from an explicit allowlist. No local DB or API keys.
import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {randomBytes} from 'node:crypto';
import AdmZip from 'adm-zip';
import {passwordHash} from '../server/access.js';
const root=resolve(import.meta.dirname,'..');
const origin=process.argv[2],destination=process.argv[3];
if(!origin||!destination)throw new Error('Usage: node scripts/package-cloud.js https://APP.liara.run OUTPUT.zip');
const privateFile=join(root,'data','cloud-access.json');mkdirSync(join(root,'data'),{recursive:true});
let access=existsSync(privateFile)?JSON.parse(readFileSync(privateFile,'utf8')):null;
if(!access){const password=randomBytes(24).toString('base64url');access={username:'rahban',password,passwordHash:await passwordHash(password)};writeFileSync(privateFile,JSON.stringify(access,null,2));}
writeFileSync(join(root,'data','cloud-access.txt'),`Rahban — hosted dashboard access\n\n${origin}\n\nUsername: ${access.username}\nPassword: ${access.password}\n\nThis file is private. Do not include it in the repository or source package.\n`);
const zip=new AdmZip();
function addTree(directory){for(const file of readdirSync(join(root,directory),{withFileTypes:true})){const name=join(directory,file.name);if(file.isDirectory())addTree(name);else zip.addFile(relative(root,join(root,name)).replaceAll('\\','/'),readFileSync(join(root,name)));}}
addTree('server');addTree('dist');
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
pkg.engines={node:'22.x'};pkg.scripts={start:'node server/index.js'};delete pkg.devDependencies;
zip.addFile('package.json',Buffer.from(JSON.stringify(pkg,null,2)));
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));delete lock.packages[''].devDependencies;lock.packages[''].engines=pkg.engines;
zip.addFile('package-lock.json',Buffer.from(JSON.stringify(lock,null,2)));
zip.addFile('hosting.private.json',Buffer.from(JSON.stringify({origin,passwordHash:access.passwordHash,username:access.username,host:'0.0.0.0',port:4310,dataDir:'/app/data'})));
zip.addFile('liara.json',Buffer.from(JSON.stringify({port:4310,node:{version:'22'},disks:[{name:'rahban-data',mountTo:'/app/data'}]},null,2)));
zip.writeZip(resolve(destination));
console.log(JSON.stringify({artifact:resolve(destination),files:zip.getEntryCount(),bytes:zip.toBuffer().length,origin,credentials:'data/cloud-access.txt (private)'}));
