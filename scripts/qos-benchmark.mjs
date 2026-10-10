/** Run: node --import ./scripts/e2e/loader.mjs scripts/qos-benchmark.mjs */
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { QoSTracker } from "../packages/mik/src/router/qos-tracker.js"

const tracker = new QoSTracker()
tracker.register("provider", "model", 100)
const update = i => { tracker.record("provider", "model", 100 + i % 10, true, 50, i); return tracker.weight("provider", "model", 100) }
for (let i = 0; i < 100_000; i++) update(i)
const batches = []
for (let batch = 0; batch < 100; batch++) {
  const start = performance.now()
  for (let i = 0; i < 1000; i++) update(i)
  batches.push((performance.now() - start)) // ms / 1000 calls → µs/call
}
// Warm the timer/instrumentation path too; its first invocation can compile inline caches.
function measure(i) { const start = performance.now(); update(i); return (performance.now() - start) * 1000 }
for (let i = 0; i < 10_000; i++) measure(i)
const singles = new Float64Array(100)
for (let i = 0; i < singles.length; i++) singles[i] = measure(i)
const result = { samples: singles.length, maxSingleUs: Math.max(...singles), averageUs: batches.reduce((a,b) => a+b, 0) / batches.length, maxBatchUsPerCall: Math.max(...batches) }
console.log(JSON.stringify(result))
assert.ok(result.averageUs < 1, "amortized sampling + weighting must stay below 1µs")
assert.ok(result.maxSingleUs < 10, "observed individual updates must stay below 10µs")
assert.ok(result.maxBatchUsPerCall < 10, "observed batches must stay below 10µs/call")
// Observed timing is evidence for this machine/run, not a hard realtime OS guarantee.
