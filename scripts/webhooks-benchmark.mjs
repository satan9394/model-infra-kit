import { NotificationBus } from '../packages/mik/src/events/bus.ts'
const means=[]
for(let sample=0;sample<24;sample++) {
 const bus=new NotificationBus();const start=performance.now()
 for(let i=0;i<900;i++)bus.emit('USAGE_RECORDED',{costMicros:1n})
 const mean=(performance.now()-start)*1000/900
 if(sample>=4)means.push(mean)
 bus.close()
}
const result={criterion:'No awaited network delivery; measured scheduling CPU overhead, not absolute0ms',samples:means.length,callsPerSample:900,meanMicros:means.reduce((a,b)=>a+b,0)/means.length,maxBatchMeanMicros:Math.max(...means),minBatchMeanMicros:Math.min(...means)}
if(process.argv.includes('--json'))process.stdout.write(JSON.stringify(result,null,2)+'\n')
else console.log(result)
