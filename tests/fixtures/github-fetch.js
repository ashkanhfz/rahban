import {readFileSync,appendFileSync} from 'node:fs';
import AdmZip from 'adm-zip';
import {sampleFiles} from '../../server/source.js';

const fallback=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
  const url=new URL(input),state=JSON.parse(readFileSync(process.env.TEST_GITHUB_STATE,'utf8'));
  if(url.origin==='https://api.github.com'){
    appendFileSync(process.env.TEST_GITHUB_CALLS,'reference\n');
    return Response.json({ref:'refs/heads/main',object:{type:'commit',sha:state.commit}});
  }
  if(url.origin==='https://codeload.github.com'){
    appendFileSync(process.env.TEST_GITHUB_CALLS,'archive\n');
    const zip=new AdmZip();for(const [name,value]of Object.entries(sampleFiles))zip.addFile('project-'+state.commit+'/'+name,Buffer.from(value));
    return new Response(zip.toBuffer());
  }
  if(url.origin==='https://api.liara.ir'&&url.pathname==='/v1/releases/release-test'&&state.releaseUnavailable)return Response.json({},{status:503});
  return fallback(input,init);
};
