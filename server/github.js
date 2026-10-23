const MAX_ARCHIVE_BYTES=10*1024*1024;
const COMMIT=/^[a-f0-9]{40}$/i;

function parseSource(repo,branch){
  if(typeof repo!=='string')throw new Error('Enter a public GitHub repository URL.');
  const match=repo.trim().match(/^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9._-]{1,100})\/?$/i);
  if(!match)throw new Error('Use https://github.com/owner/repository without query parameters.');
  const owner=match[1],name=match[2].replace(/\.git$/i,'');
  if(!name||name==='.'||name==='..')throw new Error('Invalid GitHub repository name.');
  if(typeof branch!=='string'||branch.length>120||!/^[a-z0-9_][a-z0-9._/-]*$/i.test(branch)||branch.includes('..')||branch.endsWith('.')||branch.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.lock'))){
    throw new Error('Enter a valid branch name, such as main or feature/login.');
  }
  return {repo:`https://github.com/${owner}/${name}`,branch,owner,name};
}

async function boundedBody(response,limit,message){
  if(!response.body)throw new Error('GitHub returned an empty response.');
  if(Number(response.headers.get('content-length'))>limit){await response.body.cancel();throw new Error(message);}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit)throw new Error(message);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks,size);
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}

async function get(url,fetcher,headers={}){
  let response;
  try{response=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});}
  catch{throw new Error('Could not reach GitHub. Retry the import or upload the project as a ZIP file.');}
  if(response.status!==200){
    await response.body?.cancel();
    if(response.status===403||response.status===429)throw new Error('GitHub access is limited. Try again later or upload a ZIP file.');
    if(response.status===404)throw new Error('Public repository, branch or commit not found.');
    throw new Error(`GitHub request failed (HTTP ${response.status}).`);
  }
  return response;
}

// Resolve an exact branch reference before downloading; never fetch a moving branch archive.
export async function resolveGitHubSource(repo,branch,{fetcher=fetch}={}){
  const source=parseSource(repo,branch===undefined?'main':branch);
  const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'Rahban'};
  if(branch===undefined){
    const response=await get(`https://api.github.com/repos/${source.owner}/${source.name}`,fetcher,headers);
    const bytes=await boundedBody(response,256*1024,'GitHub repository response exceeds the size limit.');
    let metadata;try{metadata=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('GitHub returned invalid repository details.');}
    branch=metadata?.default_branch;
    parseSource(repo,branch);
  }
  const response=await get(`https://api.github.com/repos/${source.owner}/${source.name}/git/ref/heads/${encodeURIComponent(branch)}`,fetcher,{
    Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'Rahban',
  });
  const bytes=await boundedBody(response,64*1024,'GitHub reference response exceeds the size limit.');
  let ref;try{ref=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('GitHub returned an invalid branch reference.');}
  if(ref?.ref!==`refs/heads/${branch}`||ref?.object?.type!=='commit'||typeof ref.object.sha!=='string'||!COMMIT.test(ref.object.sha)){
    throw new Error('GitHub returned an invalid branch commit.');
  }
  return {repo:source.repo,branch,commit:ref.object.sha.toLowerCase()};
}

export async function downloadGitHubArchive(source,{fetcher=fetch}={}){
  const parsed=parseSource(source?.repo,source?.branch);
  if(typeof source.commit!=='string'||!COMMIT.test(source.commit))throw new Error('A full GitHub commit SHA is required.');
  const response=await get(`https://codeload.github.com/${parsed.owner}/${parsed.name}/zip/${source.commit.toLowerCase()}`,fetcher);
  const bytes=await boundedBody(response,MAX_ARCHIVE_BYTES,'Archive limit is 10 MB.');
  if(!bytes.length)throw new Error('GitHub returned an empty archive.');
  return bytes;
}
