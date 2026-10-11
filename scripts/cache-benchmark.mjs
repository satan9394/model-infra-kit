import { performance } from "node:perf_hooks"
import { normalizePromptForCache } from "../packages/mik/src/cache/normalizer.ts"

const messages = [{ role: "user", content: '  {"z":2,"a":{"c":3,"b":1}}  ' }]
const options = { temperature: 0, model: "fixture:model" }
for (let i = 0; i < 5_000; i++) normalizePromptForCache(messages, options)
const count = 20_000
const start = performance.now()
for (let i = 0; i < count; i++) normalizePromptForCache(messages, options)
const averageMicros = (performance.now() - start) * 1000 / count
process.stdout.write(`${JSON.stringify({ count, averageMicros, thresholdMicros: 50, pass: averageMicros < 50 })}\n`)
if (averageMicros >= 50) process.exitCode = 1
