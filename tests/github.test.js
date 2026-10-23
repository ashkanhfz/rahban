import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveGitHubSource,downloadGitHubArchive} from '../server/github.js';

const commit='a123456789012345678901234567890123456789';
const source={repo:'https://github.com/Example/project',branch:'feature/login',commit};
const reference=(overrides={})=>({ref:'refs/heads/feature/login',object:{type:'commit',sha:commit},...overrides});

test('resolves an exact branch reference and downloads the pinned commit without credentials or redirects',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new Headers(options.headers).get('authorization'),null);
    return calls.length===1?Response.json(reference()):new Response(new Uint8Array([80,75,3,4]));
  };
  const resolved=await resolveGitHubSource(' https://github.com/Example/project.git/ ','feature/login',{fetcher});
  assert.deepEqual(resolved,source);
  assert.deepEqual(await downloadGitHubArchive(resolved,{fetcher}),Buffer.from([80,75,3,4]));
  assert.equal(calls[0].url,'https://api.github.com/repos/Example/project/git/ref/heads/feature%2Flogin');
  assert.equal(calls[1].url,`https://codeload.github.com/Example/project/zip/${commit}`);
  assert.equal(calls.length,2);
});

test('rejects unsafe repository and branch inputs before making any request',async()=>{
  const fetcher=async()=>{assert.fail('Invalid input must not cause a request.');};
  for(const repo of ['http://github.com/a/b','https://github.com.attacker.test/a/b','https://user:password@github.com/a/b','https://github.com/a/../b','https://github.com/a/%2e%2e','https://github.com/a/b?ref=x','https://github.com/a/b#readme','https://github.com/a/b/tree/main','https://github.com/a/.git','https://github.com:443/a/b']){
    await assert.rejects(resolveGitHubSource(repo,'main',{fetcher}));
  }
  for(const branch of ['',null,'main?x=y','main#x','../main','feature//login','feature/.hidden','feature/name.lock','main.','/main','main/','main\\next','main%2Fother','main@{1}','main with spaces']){
    await assert.rejects(resolveGitHubSource(source.repo,branch,{fetcher}));
  }
  for(const sha of ['main',commit.slice(0,39),commit+'a','g'.repeat(40),'../'+commit]){
    await assert.rejects(downloadGitHubArchive({...source,commit:sha},{fetcher}));
  }
});

test('rejects wrong references, non-commit objects and incomplete or malformed SHAs',async()=>{
  for(const value of [reference({ref:'refs/heads/other'}),reference({object:{type:'tag',sha:commit}}),reference({object:{type:'commit',sha:commit.slice(0,7)}}),reference({object:{type:'commit',sha:'z'.repeat(40)}}),null,[]]){
    await assert.rejects(resolveGitHubSource(source.repo,source.branch,{fetcher:async()=>Response.json(value)}),/invalid branch commit/);
  }
  await assert.rejects(resolveGitHubSource(source.repo,source.branch,{fetcher:async()=>new Response('not json')}),/invalid branch reference/);
});

test('missing references, rate limits and provider errors fail once without retrying',async()=>{
  for(const status of [301,403,404,429,500]){
    let requests=0;
    await assert.rejects(resolveGitHubSource(source.repo,source.branch,{fetcher:async()=>{requests++;return new Response('provider error',{status});}}));
    assert.equal(requests,1);
  }
  let requests=0;
  await assert.rejects(resolveGitHubSource(source.repo,source.branch,{fetcher:async()=>{requests++;throw new Error('network unavailable');}}),/Could not reach GitHub/);
  assert.equal(requests,1);
});

test('an omitted branch resolves the repository default before pinning its commit',async()=>{
  const calls=[];
  const result=await resolveGitHubSource(source.repo,undefined,{fetcher:async(url)=>{
    calls.push(url);
    return Response.json(calls.length===1?{default_branch:'master'}:{ref:'refs/heads/master',object:{type:'commit',sha:commit}});
  }});
  assert.equal(result.branch,'master');assert.equal(result.commit,commit);
  assert.equal(calls[0],'https://api.github.com/repos/Example/project');
  assert.match(calls[1],/\/git\/ref\/heads\/master$/);
});

test('streamed archives stop at the byte limit even when content length is absent or false',async()=>{
  for(const headers of [{},{'Content-Length':'1'}]){
    let cancelled=false,pulls=0;
    const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
    await assert.rejects(downloadGitHubArchive(source,{fetcher:async()=>new Response(body,{headers})}),/10 MB/);
    assert.equal(cancelled,true);assert.ok(pulls<=12);
  }
});

test('oversized declared archive is rejected before reading and cancels the body',async()=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  await assert.rejects(downloadGitHubArchive(source,{fetcher:async()=>new Response(body,{headers:{'Content-Length':String(10*1024*1024+1)}})}),/10 MB/);
  assert.equal(cancelled,true);
});

test('reference bodies are bounded and empty archives are rejected',async()=>{
  await assert.rejects(resolveGitHubSource(source.repo,source.branch,{fetcher:async()=>new Response('x'.repeat(64*1024+1))}),/size limit/);
  await assert.rejects(downloadGitHubArchive(source,{fetcher:async()=>new Response('')}),/empty archive/);
});
