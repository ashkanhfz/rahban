import client from 'prom-client';
export function makeMetrics(){
  const registry=new client.Registry();client.collectDefaultMetrics({register:registry,prefix:'rahban_'});
  const probes=new client.Counter({name:'rahban_probe_requests_total',help:'Actual synthetic HTTP probes; NOT end-user traffic',labelNames:['service','result'],registers:[registry]});
  const latency=new client.Histogram({name:'rahban_probe_duration_seconds',help:'Synthetic HTTP probe duration in seconds',labelNames:['service'],buckets:[.025,.05,.1,.25,.5,1,2,5,10],registers:[registry]});
  const up=new client.Gauge({name:'rahban_service_up',help:'Last synthetic probe: 1 healthy, 0 failed',labelNames:['service'],registers:[registry]});
  const timestamp=new client.Gauge({name:'rahban_probe_timestamp_seconds',help:'Unix timestamp of the latest probe; check freshness before treating health as current',labelNames:['service'],registers:[registry]});
  const incidents=new client.Counter({name:'rahban_incidents_total',help:'Incident investigations started',labelNames:['mode'],registers:[registry]});
  const operations=new client.Counter({name:'rahban_operations_total',help:'Approved operations completed',labelNames:['type','result'],registers:[registry]});
  const pending=new client.Gauge({name:'rahban_pending_approvals',help:'Unexpired operations waiting for human approval',registers:[registry]});
  return {registry,probes,latency,up,timestamp,incidents,operations,pending};
}
