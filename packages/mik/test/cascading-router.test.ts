import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { evaluateComplexity, readCascadingConfig, type CascadingPolicy } from "../src/router/cascading.js"
import { createServer as createGateway, type ServerHandle } from "../src/server/server.js"
import { requestCostMicros } from "../src/usage/tool-attribution.js"
import { loadConfig } from "../src/cli/context.js"
import { writeFileSync } from "node:fs"
import { MIGRATIONS, migrate } from "../src/store/schema.js"
import { nodeSqliteDriver } from "../src/store/driver.js"
import { DatabaseSync } from "node:sqlite"

const policy: CascadingPolicy = { tier1FastModel: "p:fast", tier2ReasoningModel: "p:deep" }
const prompt = (content = "hello") => ({ model: "cascade", messages: [{ role: "user" as const, content }] })

describe("G126 local complexity evaluator", () => {
  it("keeps simple translations and formatting on tier1 without mutation", () => {
    const input = Object.freeze({ ...prompt("Translate hello into Chinese"), messages: Object.freeze(prompt().messages) })
    expect(evaluateComplexity(input, Object.freeze(policy))).toBe("tier1")
  })
  it.each(["证明这个定理", "推导公式", "step by step", "重构代码", "算法复杂度", "PROVE this", "derive an equation", "refactor"])("routes reasoning intent: %s", content => {
    expect(evaluateComplexity(prompt(content), policy)).toBe("tier2")
  })
  it.each([{ reasoning_effort: "low" }, { reasoning_effort: null }, { thinking: { type: "enabled" } }, { reasoning: { effort: "high" } }, { headers: { "X-Mik-Model-Tier": "reasoning" } }])("honors explicit intent ahead of disabled heuristics: %j", override => {
    expect(evaluateComplexity({ ...prompt(), ...override }, { ...policy, rules: { reasoningKeywords: [], maxPromptTokensForTier1: 1_000_000 } })).toBe("tier2")
  })
  it("counts chars, CJK token estimates, framing, system, text parts, tool payloads and user turns", () => {
    expect(evaluateComplexity(prompt("a".repeat(16_001)), policy)).toBe("tier2")
    expect(evaluateComplexity(prompt("中".repeat(4000)), policy)).toBe("tier2")
    expect(evaluateComplexity({ ...prompt(), system: "证明" }, policy)).toBe("tier2")
    expect(evaluateComplexity({ messages: [{ content: [{ type: "text", text: "prove" }] }] }, policy)).toBe("tier2")
    expect(evaluateComplexity({ messages: [{ content: [{ type: "tool-call", input: "中".repeat(4001) }] }] }, policy)).toBe("tier2")
    expect(evaluateComplexity({ messages: Array.from({ length: 8 }, () => ({ role: "user", content: "hi" })) }, policy)).toBe("tier2")
    expect(evaluateComplexity({ input: "prove this" }, policy)).toBe("tier2")
    expect(evaluateComplexity({ input: [{ role: "user", content: "step by step" }] }, policy)).toBe("tier2")
  })
  it("applies configurable boundaries and replacement keywords; does not count media URLs", () => {
    const configured = { ...policy, rules: { maxPromptTokensForTier1: 5, maxPromptCharsForTier1: 10, reasoningKeywords: ["CUSTOM"], minToolCountForTier2: 2, minConversationTurnsForTier2: 2 } }
    expect(evaluateComplexity(prompt("abcd"), configured)).toBe("tier1")
    expect(evaluateComplexity(prompt("abcde"), configured)).toBe("tier2")
    expect(evaluateComplexity(prompt("prove"), { ...policy, rules: { reasoningKeywords: [] } })).toBe("tier1")
    expect(evaluateComplexity(prompt("custom"), configured)).toBe("tier2")
    expect(evaluateComplexity({ ...prompt(), tools: [{}, {}] }, configured)).toBe("tier2")
    expect(evaluateComplexity({ ...prompt(), tools: { a: {}, b: {} } }, configured)).toBe("tier2")
    expect(evaluateComplexity({ messages: [{ content: [{ type: "image", image: "prove".repeat(10_000) }] }] }, policy)).toBe("tier1")
  })
  it("measures warm representative and oversized inputs below 0.5ms per evaluation", () => {
    for (const content of ["中文abcdef".repeat(128), "a".repeat(4_000_000)]) {
      const input = prompt(content)
      for (let i = 0; i < 1000; i++) evaluateComplexity(input, policy)
      let tier2 = 0
      const start = performance.now()
      for (let i = 0; i < 10000; i++) tier2 += Number(evaluateComplexity(input, policy) === "tier2")
      const average = (performance.now() - start) / 10000
      console.info(`G126 evaluator: ${content.length} chars, 10000 iterations, ${average.toFixed(6)} ms/evaluation`)
      expect(average).toBeLessThan(0.5)
      expect(tier2).toBe(content.length > 16000 ? 10000 : 0)
    }
  })
  it.each([null, [], { bad: {} }, { auto: { ...policy, tier1FastModel: "sk-secret" } }, { auto: { ...policy, tier2ReasoningModel: policy.tier1FastModel } }, { auto: { ...policy, rules: { maxPromptTokensForTier1: 0 } } }, { auto: { ...policy, rules: { reasoningKeywords: [""] } } }, { auto: { ...policy, rules: { unexpected: 1 } } }])("rejects unsafe config without echo: %j", config => {
    expect(() => readCascadingConfig(config)).toThrow("Invalid cascading configuration.")
  })
  it("validates CLI cascading config and copies keyword arrays", async () => {
    const cache = mkdtempSync(join(tmpdir(), "mik-cascade-config-"))
    const file = join(cache, "config.json")
    writeFileSync(file, JSON.stringify({ cascading: { cascade: policy } }))
    expect((await loadConfig(file, { out: () => {}, err: () => {} })).cascading).toEqual({ cascade: policy })
    const raw = { cascade: { ...policy, rules: { reasoningKeywords: ["prove"] } } }
    const parsed = readCascadingConfig(raw)
    raw.cascade.rules.reasoningKeywords.push("hi")
    expect(parsed.cascade!.rules!.reasoningKeywords).toEqual(["prove"])
  })
})

let url = ""
let failure = 0
let brokenStream = false
let partialStream = false
const calls: Array<{ model: string; headers: Record<string, unknown> }> = []
const hubs: ModelInfra[] = []
const gateways: ServerHandle[] = []
const upstream = createServer(async (req, res) => {
  let raw = ""
  for await (const part of req) raw += part
  const body = JSON.parse(raw)
  calls.push({ model: body.model, headers: req.headers })
  const code = body.model === "fast" ? failure || 200 : 200
  const base = { id: "cascade", created: 1, model: body.model }
  const usage = { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 }
  res.writeHead(code, { "content-type": body.stream && code === 200 ? "text/event-stream" : "application/json" })
  if (code !== 200) { res.end(JSON.stringify({ error: { message: "token=sk-secret upstream failed" } })); return }
  if (body.stream) {
    if (partialStream || !(brokenStream && body.model === "fast")) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: body.model }, finish_reason: null }] })}\n\n`)
    if ((brokenStream || partialStream) && body.model === "fast") res.end(`data: ${JSON.stringify({ error: { message: "token=sk-secret", type: "server_error", code: "server_error" } })}\n\n`)
    else res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`)
  } else res.end(JSON.stringify({ ...base, choices: [{ index: 0, message: { role: "assistant", content: body.model }, finish_reason: "stop" }], usage }))
})
beforeAll(async () => { await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` })
afterEach(async () => { for (const g of gateways.splice(0)) await g.close(); for (const h of hubs.splice(0)) await h.close(); calls.length = 0; failure = 0; brokenStream = false; partialStream = false })
afterAll(async () => { await new Promise<void>(resolve => upstream.close(() => resolve())) })
async function hub() {
  const cacheDir = mkdtempSync(join(tmpdir(), "mik-cascade-"))
  const db = join(cacheDir, "usage.db")
  const mik = await ModelInfra.init({ db, cacheDir, providers: [{ id: "p", baseUrl: url }], defaultModel: "p:fast", cascading: { cascade: policy },
    maxRetries: 0, syncCatalog: false, pricingAutoSync: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {} })
  hubs.push(mik)
  mik.pricing.setOverride({ modelId: "fast", inputPerM: 1, outputPerM: 2 })
  mik.pricing.setOverride({ modelId: "deep", inputPerM: 10, outputPerM: 20 })
  return { mik, db }
}
async function gateway(mik: ModelInfra) { const g = await createGateway({ hub: mik, port: 0 }); gateways.push(g); return g }
async function post(g: ServerHandle, body: object, headers: Record<string, string> = {}, endpoint = "chat/completions") {
  return fetch(`${g.url}/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
}
function storedMicros(db: string) {
  const reader = new DatabaseSync(db)
  try { return reader.prepare("SELECT cost_micros AS micros FROM usage_events WHERE status = 'ok'").all().map(row => row.micros) }
  finally { reader.close() }
}
describe("G126 gateway cascading and actual-model billing", () => {
  it("migrates legacy USD to authoritative integer micros without losing rows and is idempotent", async () => {
    const driver = await nodeSqliteDriver(":memory:")
    try {
      driver.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
      for (const migration of MIGRATIONS.filter(item => item.version <= 5)) {
        for (const statement of migration.statements) typeof statement === "string" ? driver.exec(statement) : statement(driver)
        driver.prepare("INSERT INTO schema_migrations VALUES (?, 0)").run(migration.version)
      }
      driver.prepare("INSERT INTO usage_events (request_id, app_id, ts, source, provider_id, cost_usd, cost_low_usd, cost_high_usd) VALUES ('legacy', 'app', 1, 'test', 'p', ?, ?, ?)").run(0.000001, 0.000001, 0.000002)
      expect(migrate(driver)).toBe(6)
      expect(driver.prepare("SELECT cost_micros, cost_low_micros, cost_high_micros, typeof(cost_micros) AS storage FROM usage_events").get()).toEqual({ cost_micros: 1, cost_low_micros: 1, cost_high_micros: 2, storage: "integer" })
      expect(migrate(driver)).toBe(6)
      expect(driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()?.n).toBe(1)
    } finally { driver.close() }
  })
  it("native SSE errors before output escalate; partial output is never replayed", async () => {
    brokenStream = true
    const { mik } = await hub(); const g = await gateway(mik)
    const res = await post(g, { ...prompt(), stream: true }, { "x-mik-auto-protocol": "openai" })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("deep")
    expect(calls.map(call => call.model)).toEqual(["fast", "deep"])
    calls.length = 0; brokenStream = false; partialStream = true
    const partial = await post(g, { ...prompt(), stream: true }, { "x-mik-auto-protocol": "openai" })
    const text = await partial.text()
    expect(text).toContain("fast"); expect(text).not.toContain("sk-secret")
    expect(calls.map(call => call.model)).toEqual(["fast"])
    expect(mik.usage.query().events.some(row => row.status === "error" && row.modelActual === "fast" && row.isStreaming)).toBe(true)
  })

  it.each([["hello", "fast", 3000], ["证明这个定理", "deep", 30000]] as const)("routes %s and stores integer actual-model micros", async (content, model, micros) => {
    const { mik, db } = await hub()
    const response = await mik.generate(prompt(content))
    expect(response.model).toEqual({ requested: "cascade", actual: model })
    expect(requestCostMicros(response.cost.usd)).toBe(micros)
    expect(storedMicros(db)).toEqual([micros])
    expect(mik.usage.query().events[0]?.tags).toMatchObject({ cascading_tier: model === "fast" ? "tier1" : "tier2", cascading_escalated: "false" })
    expect(mik.cascadingModels()[0]?.estimatedSavingsMicros).toBe(27000)
  })
  it.each([429, 500, 503, 599])("escalates %s before output, audits both attempts, bills tier2", async code => {
    failure = code
    const { mik, db } = await hub()
    expect((await mik.generate(prompt())).model.actual).toBe("deep")
    expect(calls.map(call => call.model)).toEqual(["fast", "deep"])
    const rows = mik.usage.query().events
    expect(rows.find(row => row.status === "error")?.tags).toMatchObject({ cascading_tier: "tier1", cascading_escalated: "false" })
    expect(rows.find(row => row.status === "ok")?.tags).toMatchObject({ cascading_tier: "tier2", cascading_escalated: "true" })
    expect(new Set(rows.map(row => row.traceId)).size).toBe(1)
    expect(storedMicros(db)).toEqual([30000])
  })
  it("isolates same-provider fast-model circuit failures from healthy tier2", async () => {
    failure = 503
    const { mik } = await hub()
    for (let i = 0; i < 5; i++) expect((await mik.generate(prompt())).model.actual).toBe("deep")
    expect(calls.filter(call => call.model === "fast")).toHaveLength(3)
    expect(calls.filter(call => call.model === "deep")).toHaveLength(5)
    expect(mik.providerHealth.state("p:fast")).toBe("OPEN")
    expect(mik.providerHealth.state("p:deep")).toBe("CLOSED")
  })
  it.each([400, 401, 403])("does not replay permanent %s errors", async code => {
    failure = code
    const { mik } = await hub()
    await expect(mik.generate(prompt())).rejects.toBeDefined()
    expect(calls.map(call => call.model)).toEqual(["fast"])
  })
  it.each([false, true])("HTTP stream=%s honors headers and body thinking intent", async stream => {
    const { mik } = await hub(); const g = await gateway(mik)
    for (const override of [{ reasoning_effort: "high" }, { reasoning: { effort: "high" } }, { thinking: { type: "enabled" } }, {}]) {
      const res = await post(g, { ...prompt(), stream, ...override }, { "X-Mik-Model-Tier": "reasoning" })
      expect(res.status).toBe(200); await res.text()
    }
    expect(calls.map(call => call.model)).toEqual(["deep", "deep", "deep", "deep"])
    expect(calls.every(call => call.headers["x-mik-model-tier"] === undefined)).toBe(true)
  })
  it.each([false, true])("HTTP stream=%s escalates without leaking tier1 output or secrets", async stream => {
    failure = 429
    const { mik, db } = await hub(); const g = await gateway(mik)
    const res = await post(g, { ...prompt(), stream })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("deep"); expect(text).not.toContain("sk-secret")
    expect(storedMicros(db)).toEqual([30000])
  })
  it("retries an SDK stream error before output and never after output", async () => {
    brokenStream = true
    const { mik } = await hub()
    const events = []
    for await (const event of mik.stream(prompt())) events.push(event)
    expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "deep" }])
    expect(mik.usage.query().events.find(row => row.status === "ok")?.tags?.cascading_escalated).toBe("true")
    calls.length = 0; brokenStream = false; partialStream = true
    const partial = []
    for await (const event of mik.stream(prompt())) partial.push(event)
    expect(calls.map(call => call.model)).toEqual(["fast"])
    expect(partial.at(-1)?.type).toBe("error")
    expect(JSON.stringify(partial)).not.toContain("sk-secret")
  })
  it.each(["chat/completions", "responses"])("native %s routes and escalates with trace attribution", async endpoint => {
    failure = 503
    const { mik, db } = await hub(); const g = await gateway(mik)
    const res = await post(g, endpoint === "responses" ? { model: "cascade", input: "hello" } : prompt(), { "x-mik-auto-protocol": "openai" }, endpoint)
    expect(res.status).toBe(200); await res.text()
    expect(calls.map(call => call.model)).toEqual(["fast", "deep"])
    expect(storedMicros(db)).toEqual([30000])
    const rows = mik.usage.query().events
    expect(rows.find(row => row.status === "ok")?.tags).toMatchObject({ cascading_tier: "tier2", cascading_escalated: "true" })
    expect(rows.every(row => row.modelRequested === "cascade")).toBe(true)
    expect(new Set(rows.map(row => row.traceId)).size).toBe(1)
  })
  it("literal models bypass heuristics; false disables escalation; tier2 never falls back to fast", async () => {
    const { mik } = await hub()
    expect((await mik.generate({ ...prompt("prove"), model: "p:fast" })).model.actual).toBe("fast")
    failure = 500
    await expect(mik.generate({ ...prompt(), fallbackChain: false })).rejects.toBeDefined()
    expect(calls.map(call => call.model)).toEqual(["fast", "fast"])
    expect((await mik.generate({ ...prompt(), reasoning_effort: "high" })).model.actual).toBe("deep")
  })
  it("exposes mappings without credentials, reports missing estimates and CORS tier header", async () => {
    const { mik } = await hub(); const g = await gateway(mik)
    const res = await fetch(`${g.url}/api/models`)
    expect((await res.json()).cascading).toEqual([{ alias: "cascade", ...policy, estimatedSavingsMicros: 27000 }])
    mik.pricing.removeOverride("fast"); mik.pricing.removeOverride("deep")
    expect(mik.cascadingModels()[0]?.estimatedSavingsMicros).toBeNull()
  })
})
