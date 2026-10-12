import { RateLimiter } from '../packages/mik/src/quota/rate-limiter.ts'
const n=100_000
const results={}
for(const kind of ['admitted','denied-tpm']) {
 const batches=[]
 for(let batch=0;batch<10;batch++) {
  const limiter=new RateLimiter({maxRpm:n,maxTpm:n},kind==='admitted'?undefined:()=>0)
  if(kind!=='admitted')for(let i=0;i<n;i++)limiter.check()
  const start=performance.now()
  for(let i=0;i<n;i++)limiter.check(kind==='denied-tpm'?n:1)
  batches.push((performance.now()-start)*1000/n)
 }
 results[kind]=batches.slice(2)
}
const expiry=[]
// Each timed operation expires a freshly filled 100000-entry ring. Filling is
// outside measurement; early iterations warm the bulk-expiry branch itself.
for(let trial=0;trial<60;trial++) {
 let now=0
 const limiter=new RateLimiter({maxRpm:n,maxTpm:n},()=>now)
 for(let i=0;i<n;i++)limiter.check()
 now=60000
 const start=performance.now()
 limiter.check()
 const micros=(performance.now()-start)*1000
 if(trial>=10)expiry.push(micros)
}
results['bulk-expiry']=[expiry.reduce((a,b)=>a+b,0)/expiry.length]
const maximum=Math.max(...Object.values(results).flat())
console.log(JSON.stringify({benchmark:'warmed full-capacity rolling-window paths',microsecondsPerCall:results,bulkExpirySamples:expiry,maxBatchMeanMicros:maximum,limitMicros:5,hardRealtimeGuarantee:false}))
if(maximum>=5)process.exitCode=1
