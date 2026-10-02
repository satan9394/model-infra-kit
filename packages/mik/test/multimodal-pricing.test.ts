import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestServer } from "@ai-sdk/test-server"
import { jsonSchema, tool } from "ai"
import { PricingCatalog } from "llm-pricing"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { calculateTierCostMicros, deriveModelPricingTier, isModelPricingTier } from "../src/pricing/tiers.js"
import { exportPriceSnapshot, importPriceSnapshot, priceKey } from "../src/pricing/snapshot.js"
import { allocateToolCosts, requestCostMicros, requestCostMicrosBigInt, sanitizeToolCalls, ToolTraceCollector } from "../src/usage/tool-attribution.js"
import type { ToolCallAttribution, UsageEvent } from "../src/types.js"
import { acquireEventBus } from "../src/server/events.js"
import { Store } from "../src/store/database.js"
import { createServer } from "../src/server/index.js"

const tier = deriveModelPricingTier({ modelId: "media-model", providerId: "p", source: "manual", updatedAt: "2026-10-02T00:00:00Z",
  inputPerM: 1, outputPerM: 2, image_per_megapixel_micros: 7, audio_input_micros_per_second: 3, audio_output_micros_per_second: 5 })
const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
const call: ToolCallAttribution = { tool_name: "lookup", id: "one", input_hash: "a".repeat(64), start_offset_ms: 20, duration_ms: 5, input_tokens: 5, output_tokens: 2, cost_micros: 0 }
const response = (tools: boolean, billed?: number) => ({ id: "completion", object: "chat.completion", created: 1, model: "media-model",
  choices: [{ index: 0, message: tools ? { role: "assistant", content: null, tool_calls: ["a", "b"].map(id => ({ id, type: "function", function: { name: "lookup", arguments: '{"private":"never-store-me"}' } })) } : { role: "assistant", content: "done" }, finish_reason: tools ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: tools ? 11 : 20, completion_tokens: tools ? 5 : 7, ...(billed === undefined ? {} : { cost: billed }) } })
function frames(tools: boolean): string[] {
  const delta = tools ? { role: "assistant", tool_calls: ["a", "b"].map((id, index) => ({ index, id, type: "function", function: { name: "lookup", arguments: '{"private":"never-store-me"}' } })) } : { role: "assistant", content: "done" }
  return [ { id: "stream", object: "chat.completion.chunk", created: 1, model: "media-model", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "stream", object: "chat.completion.chunk", created: 1, model: "media-model", choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] },
    { id: "stream", object: "chat.completion.chunk", created: 1, model: "media-model", choices: [], usage: { prompt_tokens: tools ? 11 : 20, completion_tokens: tools ? 5 : 7 } } ].map(part => `data: ${JSON.stringify(part)}\n\n`).concat("data: [DONE]\n\n")
}
const root = "https://g110.test"
const server = createTestServer({
  [`${root}/generate/chat/completions`]: { response: [{ type: "json-value", body: response(true) }, { type: "json-value", body: response(false) }] },
  [`${root}/billed/chat/completions`]: { response: { type: "json-value", body: response(false, 0.000002) } },
  [`${root}/stream/chat/completions`]: { response: [true, false].map(tools => ({ type: "stream-chunks" as const, headers: { "content-type": "text/event-stream" }, chunks: frames(tools) })) },
})
const hubs: ModelInfra[] = []
beforeAll(() => { server.server.start(); process.env.MIK_G110_KEY = "test-only" })
afterEach(async () => { await Promise.all(hubs.splice(0).map(hub => hub.close())); server.server.reset() })
afterAll(() => { server.server.stop(); process.env.MIK_G110_KEY = "" })
async function hubFor(path: string, onUsage?: (event: UsageEvent) => void) {
  const hub = await ModelInfra.init({ appId: "g110", db: ":memory:", syncCatalog: false, pricingAutoSync: false,
    cacheDir: mkdtempSync(join(tmpdir(), "mik-g110-")), pricingCatalog: new PricingCatalog({ sources: [] }), maxRetries: 0,
    defaultModel: "p:media-model", providers: [{ id: "p", protocol: "openai-compatible", baseUrl: `${root}/${path}`, apiKeyRef: "env:MIK_G110_KEY", enabled: true }], onUsage })
  hubs.push(hub)
  expect(hub.pricing.importSnapshot(exportPriceSnapshot({ [priceKey(tier)]: tier })).errors).toEqual([])
  return hub
}
const request = () => ({ messages: [{ role: "user" as const, content: "hi" }], media: { image_pixels: 1_000_000, audio_input_ms: 500 },
  tools: { lookup: tool({ inputSchema: jsonSchema({ type: "object", properties: { private: { type: "string" } }, required: ["private"] }), execute: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { secret: "never-store-output" } } }) } })

describe("G110 multimodal exact billing", () => {
  it("rejects lossy USD tier boundaries and never zeroes large attribution budgets", async () => {
    const hub = await hubFor("generate")
    const huge = { ...tier, rates: { ...tier.rates, image_per_megapixel_micros: Number.MAX_SAFE_INTEGER } }
    expect(hub.pricing.importSnapshot(exportPriceSnapshot({ [priceKey(huge)]: huge })).errors).toEqual([])
    expect(calculateTierCostMicros(huge, zero, { image_pixels: 1_000_000 }).costLowMicros).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => hub.pricing.estimate({ model: "media-model", providerId: "p", usage: zero, media: { image_pixels: 1_000_000 } })).toThrow("USD number boundary")
    expect(requestCostMicrosBigInt(10_000_000_000)).toBe(10_000_000_000_000_000n)
    expect(requestCostMicros(10_000_000_000)).toBe(Number.MAX_SAFE_INTEGER)
    expect(allocateToolCosts([{ ...call, input_tokens: 1, output_tokens: 0 }], requestCostMicros(10_000_000_000), { input: 1, output: 0 })[0]?.cost_micros).toBe(Number.MAX_SAFE_INTEGER)
  })
  it("rounds text, pixels and millisecond charges together once", () => {
    expect(calculateTierCostMicros(tier, { input: 1, output: 1 }, { image_pixels: 1_500_000, audio_input_ms: 250, audio_output_ms: 100 })).toEqual({ costLowMicros: 15, costHighMicros: 15 })
    expect(calculateTierCostMicros(tier, zero, { image_pixels: 1, audio_input_ms: 1 })).toEqual({ costLowMicros: 0, costHighMicros: 0 })
    expect(calculateTierCostMicros(tier, zero, { image_pixels: 500_000 })).toEqual({ costLowMicros: 4, costHighMicros: 4 })
  })
  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid measured quantities %s", value => {
    expect(() => calculateTierCostMicros(tier, zero, { image_pixels: value })).toThrow(RangeError)
    expect(() => deriveModelPricingTier({ modelId: "m", providerId: "p", source: "manual", updatedAt: "now", inputPerM: 0, outputPerM: 0, image_per_megapixel_micros: value })).toThrow(RangeError)
    expect(isModelPricingTier({ ...tier, rates: { ...tier.rates, audio_input_micros_per_second: value } })).toBe(false)
  })
  it("rejects overflow and preserves huge safe integer products using BigInt", () => {
    const expensive = { ...tier, rates: { ...tier.rates, image_per_megapixel_micros: Number.MAX_SAFE_INTEGER } }
    expect(calculateTierCostMicros(expensive, zero, { image_pixels: 1_000_000 }).costLowMicros).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => calculateTierCostMicros(expensive, zero, { image_pixels: 1_000_001 })).toThrow(RangeError)
    expect(requestCostMicros(0.0000005)).toBe(1)
  })
  it("preserves media rates in validated snapshots and bills only explicitly configured rates", async () => {
    const json = exportPriceSnapshot({ [priceKey(tier)]: tier })
    expect(importPriceSnapshot(json).models[priceKey(tier)]).toEqual(tier)
    const hub = await hubFor("generate")
    expect(hub.pricing.estimate({ model: "media-model", providerId: "p", usage: zero, media: { image_pixels: 1_000_000, audio_input_ms: 500 } }).usd).toBe(0.000009)
    const textOnly = deriveModelPricingTier({ modelId: "plain", providerId: "p", source: "manual", updatedAt: tier.updatedAt, inputPerM: 1, outputPerM: 2 })
    expect(calculateTierCostMicros(textOnly, zero, { image_pixels: 1_000_000 }).costLowMicros).toBe(0)
  })
  it("keeps the provider-reported amount authoritative over media estimates", async () => {
    const hub = await hubFor("billed")
    const result = await hub.generate({ messages: [{ role: "user", content: "hi" }], media: { image_pixels: 2_000_000 } })
    expect(result.cost.usd).toBe(0.000002)
    expect(hub.usage.query().events[0]?.cost.usd).toBe(0.000002)
  })
  it("usage-report HTTP API prices measured media and roundtrips sanitized tool attribution", async () => {
    const hub = await hubFor("billed")
    const handle = await createServer({ hub, port: 0, heartbeatMs: 0 })
    try {
      const body = { requestId: "http-media", providerId: "p", modelActual: "media-model", usage: zero, media: { image_pixels: 1_000_000, audio_input_ms: 500 }, tool_calls: [{ ...call, cost_micros: 100, input: "DO NOT STORE" }] }
      const written = await fetch(`${handle.url}/api/usage/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      expect(written.status).toBe(200)
      const read = await fetch(`${handle.url}/api/usage/logs`)
      expect(read.status).toBe(200)
      const result = await read.json() as { events: UsageEvent[] }
      const event = result.events.find(event => event.requestId === "http-media")!
      expect(event.cost.usd).toBe(0.000009)
      expect(event.tool_calls?.[0]?.cost_micros).toBe(9)
      expect(JSON.stringify(event)).not.toContain("DO NOT STORE")
      const invalid = await fetch(`${handle.url}/api/usage/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, requestId: "invalid-media", media: { audio_input_ms: 0.1 } }) })
      expect(invalid.status).toBe(200) // existing report contract rejects per item, including a one-item batch
      expect(await invalid.json()).toMatchObject({ accepted: 0, rejected: [{ index: 0, reason: '"media" quantities must be non-negative safe integers.' }] })
      expect(hub.usage.get("invalid-media")).toBeNull()
    } finally { await handle.close() }
  })
})

describe("G110 native tool execution attribution", () => {
  it("does not overwrite earlier step counts when an upstream reuses tool IDs", () => {
    const trace = new ToolTraceCollector(Date.now())
    for (const tokens of [5, 11]) {
      trace.start({ toolCall: { toolCallId: "same", toolName: "lookup", input: { tokens } } })
      trace.end({ toolCall: { toolCallId: "same" }, toolExecutionMs: 3 })
      trace.step({ toolCalls: [{ toolCallId: "same" }], usage: { inputTokens: tokens, outputTokens: 1 } })
    }
    expect(trace.finish(17, { ...zero, input: 16, output: 2 })?.map(call => call.input_tokens)).toEqual([5, 11])
  })
  it.each(["generate", "stream"])("captures %s native multi-step tool timing, hashes, bounded costs and roundtrip", async path => {
    const emitted: UsageEvent[] = []
    const hub = await hubFor(path, event => emitted.push(event))
    if (path === "generate") expect((await hub.generate(request())).text).toBe("done")
    else { const events = []; for await (const event of hub.stream(request())) events.push(event); expect(events.at(-1)?.type).toBe("finish") }
    const event = hub.usage.query().events[0]!
    expect(event.usage.input).toBe(31)
    expect(event.usage.output).toBe(12)
    expect(event.cost.usd).toBe(0.000064) // 31 + 24 + 7 + 1.5, rounded once
    expect(event.tool_calls).toHaveLength(2)
    expect(event.tool_calls?.map(call => call.input_tokens)).toEqual([6, 5])
    expect(event.tool_calls?.map(call => call.output_tokens)).toEqual([3, 2])
    for (const tool of event.tool_calls!) {
      expect(tool.duration_ms).toBeGreaterThanOrEqual(1)
      expect(tool.start_offset_ms).toBeGreaterThanOrEqual(0)
      expect(tool.input_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(tool.tool_name).toBe("lookup")
    }
    const sum = event.tool_calls!.reduce((total, call) => total + call.cost_micros, 0)
    expect(sum).toBeGreaterThan(0)
    expect(sum).toBeLessThanOrEqual(requestCostMicros(event.cost.usd))
    expect(emitted[0]?.tool_calls).toEqual(event.tool_calls)
    expect(hub.usage.get(event.requestId)?.tool_calls).toEqual(event.tool_calls)
    expect(JSON.stringify(event)).not.toContain("never-store")
    expect(hub.usage.byTag().some(bucket => bucket.key.includes("tool_calls"))).toBe(false)
  })
  it("allocation is bounded for zero counts, skewed steps and maximum safe integer costs", () => {
    for (const micros of [0, 1, 100, Number.MAX_SAFE_INTEGER]) {
      const allocated = allocateToolCosts([call, { ...call, id: "two" }], micros, { input: 0, output: 1 })
      expect(allocated.reduce((sum, call) => sum + BigInt(call.cost_micros), 0n)).toBeLessThanOrEqual(BigInt(micros))
    }
    expect(allocateToolCosts([{ ...call, input_tokens: 0, output_tokens: 0 }], 100, zero)[0]?.cost_micros).toBe(0)
  })
  it("sanitizes hostile arrays, redacts names, preserves structured JSON and emits normalized events", async () => {
    const emitted: UsageEvent[] = []
    const hub = await hubFor("billed", event => emitted.push(event))
    const bridge = acquireEventBus(hub)
    const busEvents: unknown[] = []
    const unsubscribe = bridge.bus.subscribe(event => busEvents.push(event.data))
    try {
      const raw = Array.from({ length: 30 }, (_, i) => ({ ...call, id: `c${i}`, tool_name: "Authorization: Bearer sk-secret-123456789", cost_micros: 2, input: "DO NOT STORE" }))
      hub.usage.record({ requestId: "raw", ts: 1, source: "report", providerId: "p", modelRequested: "m", modelActual: "m", usage: zero, cost: { usd: 0.000005, low: 0.000005, high: 0.000005, basis: "exact", source: "manual" }, status: "ok", isStreaming: false, tool_calls: raw })
      const stored = hub.usage.get("raw")!
      expect(stored.tool_calls).toHaveLength(30)
      expect(JSON.stringify(stored.tool_calls)).not.toContain("sk-secret")
      expect(JSON.stringify(stored.tool_calls)).not.toContain("DO NOT STORE")
      expect(stored.tool_calls!.reduce((sum, call) => sum + call.cost_micros, 0)).toBe(5)
      expect(emitted[0]?.tool_calls).toEqual(stored.tool_calls)
      expect((busEvents[0] as UsageEvent).tool_calls).toEqual(stored.tool_calls)
      hub.usage.withAppScope("scoped", () => hub.usage.record({ ...stored, requestId: "scoped", appId: "ignored" }))
      expect((busEvents[1] as UsageEvent).appId).toBe("scoped")
      expect(hub.usage.get("scoped", { appId: "" })?.appId).toBe("scoped")
      hub.usage.record({ ...stored, requestId: "explicit", appId: "explicit" })
      expect((busEvents[2] as UsageEvent).appId).toBe("explicit")
      expect(sanitizeToolCalls([null, {}, { ...call, input_hash: "raw-prompt" }], 5)).toBeUndefined()
    } finally { unsubscribe(); bridge.release() }
  })
  it("reads malformed and hostile legacy arrays defensively", async () => {
    const store = await Store.open({ path: ":memory:" })
    try {
      const event: UsageEvent = { requestId: "legacy", appId: "g110", ts: 1, source: "report", providerId: "p", modelRequested: "m", modelActual: "m", usage: zero, cost: { usd: 0.000001, low: 0.000001, high: 0.000001, basis: "exact", source: "manual" }, status: "ok", isStreaming: false }
      store.usage.insert(event)
      store.driver.prepare("UPDATE usage_events SET tags_json = ? WHERE request_id = ?").run("{bad json", "legacy")
      expect(store.usage.get("legacy")?.tool_calls).toBeUndefined()
      store.driver.prepare("UPDATE usage_events SET tags_json = ? WHERE request_id = ?").run(JSON.stringify({ tool_calls: [{ ...call, cost_micros: 999, tool_name: "Authorization: Bearer sk-legacy-secret", output: "DO NOT STORE" }] }), "legacy")
      const stored = store.usage.get("legacy")!
      expect(stored.tool_calls?.[0]?.cost_micros).toBe(1)
      expect(JSON.stringify(stored)).not.toContain("sk-legacy")
      expect(JSON.stringify(stored)).not.toContain("DO NOT STORE")
    } finally { store.close() }
  })
})
