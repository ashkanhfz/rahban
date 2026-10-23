import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.js';
import {openRuntime} from '../server/runtime.js';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'rahban-runtime-'));
  let store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},reopen(){store.db.close();store=openStore(dir);return store;}};
}

test('first boot persists attribution and returns detached snapshots',t=>{
  const f=fixture(t),at=Date.parse('2026-10-23T15:00:00Z');
  const runtime=openRuntime(f.store,{clock:()=>at,bootId:'boot-first'});
  const first=runtime.snapshot();
  assert.match(first.instanceId,/^[a-f0-9-]{36}$/);
  assert.equal(first.signature,`rahban:${first.instanceId}`);
  assert.equal(first.bootId,'boot-first');
  assert.equal(first.startedAt,new Date(at).toISOString());
  assert.equal(first.lastSeenAt,first.startedAt);
  assert.equal(first.recovered,false);
  assert.equal(first.previousBootId,null);
  assert.equal(first.previousLastSeenAt,null);
  assert.equal(first.previousStoppedAt,null);
  assert.equal(first.stoppedAt,null);
  assert.equal(f.store.list('runtime')[0].instanceId,first.instanceId);
  first.instanceId='tampered';
  assert.notEqual(runtime.snapshot().instanceId,first.instanceId);
});

test('restart preserves identity and the previous persisted heartbeat across database reopening',t=>{
  const f=fixture(t);
  let at=Date.parse('2026-10-23T15:00:00Z');
  const first=openRuntime(f.store,{clock:()=>at});
  at+=15_000;
  const heartbeat=first.heartbeat();
  assert.equal(heartbeat.lastSeenAt,new Date(at).toISOString());
  at+=60_000;
  const next=openRuntime(f.reopen(),{clock:()=>at}).snapshot();
  assert.equal(next.instanceId,heartbeat.instanceId);
  assert.equal(next.signature,heartbeat.signature);
  assert.notEqual(next.bootId,heartbeat.bootId);
  assert.equal(next.previousBootId,heartbeat.bootId);
  assert.equal(next.previousLastSeenAt,heartbeat.lastSeenAt);
  assert.equal(next.previousStoppedAt,null);
  assert.equal(next.recovered,true);
  assert.equal(next.startedAt,new Date(at).toISOString());
  assert.equal(next.lastSeenAt,next.startedAt);
  assert.equal(next.stoppedAt,null);
  assert.equal(f.store.list('runtime').length,1);
});

test('orderly shutdown is idempotent and cannot be cleared by a late heartbeat',t=>{
  const f=fixture(t);
  let at=Date.parse('2026-10-23T15:00:00Z');
  const first=openRuntime(f.store,{clock:()=>at,bootId:'boot-first'});
  at+=30_000;
  const stopped=first.stop();
  assert.equal(stopped.stoppedAt,new Date(at).toISOString());
  assert.equal(stopped.lastSeenAt,stopped.stoppedAt);
  at+=15_000;
  assert.deepEqual(first.stop(),stopped);
  assert.deepEqual(first.heartbeat(),stopped);
  const next=openRuntime(f.reopen(),{clock:()=>at,bootId:'boot-next'}).snapshot();
  assert.equal(next.instanceId,stopped.instanceId);
  assert.equal(next.previousBootId,stopped.bootId);
  assert.equal(next.previousStoppedAt,stopped.stoppedAt);
  assert.equal(next.previousLastSeenAt,stopped.lastSeenAt);
  assert.equal(next.stoppedAt,null);
  assert.equal(next.recovered,true);
});

test('separate data stores have separate instance identities',t=>{
  const first=fixture(t),second=fixture(t);
  const a=openRuntime(first.store).snapshot(),b=openRuntime(second.store).snapshot();
  assert.notEqual(a.instanceId,b.instanceId);
  assert.notEqual(a.signature,b.signature);
  assert.equal(a.recovered,false);
  assert.equal(b.recovered,false);
});
