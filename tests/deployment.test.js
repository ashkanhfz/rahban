import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSettings,previewDeployment} from '../server/deployment.js';

test('empty deployment settings use detected port and defaults; explicit false is preserved',()=>{
  const source={port:8080,portDetected:true,checks:[],ready:true};
  const defaults={port:8080,healthPath:'/',healthTimeoutMs:5000,buildCache:true};
  assert.deepEqual(resolveSettings(source),defaults);
  assert.deepEqual(resolveSettings(source,null),defaults);
  assert.deepEqual(resolveSettings(source,{port:null,healthPath:' ',healthTimeoutMs:'',buildCache:null}),defaults);
  assert.deepEqual(resolveSettings(source,{port:'4000',healthPath:'/healthz',healthTimeoutMs:7000,buildCache:false}),{port:4000,healthPath:'/healthz',healthTimeoutMs:7000,buildCache:false});
  assert.equal(resolveSettings(source,{},9000).port,9000);
  assert.deepEqual(previewDeployment(source,{}).defaults,defaults);
});

test('invalid ports and probe paths cannot redirect checks to another host',()=>{
  for(const settings of [{port:0},{port:65536},{port:12.5},{healthTimeoutMs:0},{healthPath:'https://example.com'},{healthPath:'//example.com'},{healthPath:'/../admin'},{healthPath:'/\\example.com'},{healthPath:'/%2fadmin'},{buildCache:'false'},{unknown:true}]){
    assert.throws(()=>resolveSettings({},settings));
  }
});
