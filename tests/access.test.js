import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {request} from 'node:http';
import {installAccess,passwordHash} from '../server/access.js';
test('public operator gate protects frontend, metrics and API; rejects forged login and origin; logout revokes access',async()=>{
  const app=express();app.use(express.urlencoded({extended:false}));
  installAccess(app,{origin:'https://rahban.example',passwordHash:await passwordHash('test-only-password')});
  app.get('/api/state',(req,res)=>res.json({private:true}));app.get('/metrics',(req,res)=>res.send('private metrics'));app.get('/healthz',(req,res)=>res.send('ok'));app.get('/',(req,res)=>res.send('private frontend'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(path,options={})=>new Promise((resolve,reject)=>{
    const body=options.body?.toString();
    const req=request(base+path,{method:options.method||'GET',headers:{Host:'rahban.example',...(body?{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}:{}),...options.headers}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>resolve({status:res.statusCode,headers:{get:n=>res.headers[n.toLowerCase()],getSetCookie:()=>res.headers['set-cookie']||[]},text:async()=>text}));});req.on('error',reject);req.end(body);
  });
  try{
    assert.equal((await call('/')).status,303);assert.equal((await call('/api/state')).status,401);assert.equal((await call('/metrics')).status,401);assert.equal((await call('/healthz')).status,200);
    assert.equal((await call('/auth/login',{headers:{Origin:'https://attacker.example'}})).status,403);
    assert.equal((await call('/auth/login',{method:'POST',body:new URLSearchParams({username:'rahban',password:'test-only-password'})})).status,403);
    const form=await call('/auth/login'),html=await form.text(),nonce=html.match(/name="nonce" value="([a-f0-9]+)"/)[1];
    // Browsers may also follow a favicon redirect to login; it must not invalidate the visible form.
    await call('/auth/login');
    const logged=await call('/auth/login',{method:'POST',headers:{Origin:'https://rahban.example'},body:new URLSearchParams({nonce,username:'rahban',password:'test-only-password'})});
    assert.equal(logged.status,303);assert.equal(logged.headers.get('location'),'/');
    assert.match(logged.headers.get('set-cookie').join(';'),/Secure/);assert.match(logged.headers.get('set-cookie').join(';'),/HttpOnly/);
    const operator=logged.headers.getSetCookie().find(c=>c.startsWith('__Host-rahban_operator=')).split(';')[0];
    assert.equal((await call('/api/state',{headers:{Cookie:operator}})).status,200);
    assert.equal((await call('/api/state',{headers:{Host:'attacker.example',Cookie:operator}})).status,403);
    assert.equal((await call('/auth/login',{method:'POST',headers:{Origin:'https://rahban.example'},body:new URLSearchParams({nonce,username:'rahban',password:'test-only-password'})})).status,403);
    await call('/auth/logout',{method:'POST',headers:{Cookie:operator,Origin:'https://rahban.example'}});
    assert.equal((await call('/api/state',{headers:{Cookie:operator}})).status,401);
  }finally{await new Promise(r=>server.close(r));}
});
test('public hosting fails closed without HTTPS and a password hash',()=>{
  assert.throws(()=>installAccess(express(),{origin:'http://rahban.example',passwordHash:''}));
  assert.throws(()=>installAccess(express(),{origin:'https://rahban.example',passwordHash:''}));
});
