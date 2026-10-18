import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { tool, jsonSchema } from "ai"
import { ModelInfra } from "../src/hub.js"
import type { ModelInfraConfig, ModelRequest } from "../src/types.js"
import { readCacheOptions } from "../src/cache/lru.js"
import { normalizePromptForCache } from "../src/cache/normalizer.js"
import { createMinHashSignature, estimateJaccard } from "../src/cache/approximate.js"
import { Store } from "../src/store/database.js"

const directory = mkdtempSync(join(tmpdir(), "mik-g135-"))
const prompt = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ")
const changed = prompt + " " + Array.from({ length: 7 }, (_, i) => `extra${i}`).join(" ")
const request = (content = prompt): ModelRequest => ({ messages: [{ role: "user", content }], temperature: 0 })
const isolatedRequests: Partial<ModelRequest>[] = [
  { temperature: undefined, cache: true }, { temperature: 1, cache: true }, { cache: false },
  { system: "different system" }, { maxTokens: 99 }, { batch: true }, { model: "test:other" },
  { reasoning_effort: "high" }, { headers: { "x-mik-no-cache": "true" } },
  { headers: { custom: "value" } },
  { tools: { inspect: tool({ inputSchema: jsonSchema({ type: "object" }) }) } },
]
let calls = 0, upstreamUrl = ""
let receivedHeaders: Record<string, string | string[] | undefined> = {}
const upstream = createServer(async (req, res) => {
  let text = ""
  for await (const part of req) text += part
  const body = JSON.parse(text)
  calls++
  receivedHeaders = req.headers
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const frame of [
      { choices: [{ index: 0, delta: { content: "fixture answer" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ]) res.write(`data: ${JSON.stringify({ id: "g135", object: "chat.completion.chunk", created: 1, model: "model", ...frame })}\n\n`)
    res.end("data: [DONE]\n\n")
  } else {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "g135", object: "chat.completion", created: 1, model: "model",
      choices: [{ index: 0, message: body.tools?.length
        ? { role: "assistant", content: null, tool_calls: [{ id: "call-g135", type: "function", function: { name: "inspect", arguments: "{}" } }] }
        : { role: "assistant", content: "fixture answer" }, finish_reason: body.tools?.length ? "tool_calls" : "stop" }], usage }))
  }
})
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())) })
async function hub(cache: ModelInfraConfig["cache"] = { approximate: true }, db = ":memory:") {
  const mik = await ModelInfra.init({ db, cache, cacheDir: directory, syncCatalog: false, pricingAutoSync: false,
    env: { G135_KEY: "fixture-credential" }, providers: [{ id: "test", baseUrl: upstreamUrl, apiKeyRef: "env:G135_KEY" }],
    defaultModel: "test:model", pricingFetch: async () => { throw new Error("offline") } })
  mik.pricing.setOverride({ modelId: "model", inputPerM: 2, outputPerM: 3 })
  return mik
}

describe("approximate gateway opt-in, isolation and integer accounting", () => {
  it("validates boolean config and admits the control header without changing exact keys", () => {
    expect(readCacheOptions({})).toEqual({ approximate: false })
    expect(readCacheOptions({ approximate: true })).toEqual({ approximate: true })
    for (const value of [1, "true", null, undefined]) expect(() => readCacheOptions({ approximate: value })).toThrow()
    const key = normalizePromptForCache(request().messages, request())
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(normalizePromptForCache(request().messages, { ...request(), headers: { "X-Mik-Approx-Threshold": "0.98" } })).toBe(key)
    for (const header of ["Authorization", "custom"]) expect(normalizePromptForCache(request().messages, { ...request(), headers: { [header]: "value" } })).toBeNull()
    expect(estimateJaccard(createMinHashSignature(prompt), createMinHashSignature(changed))).toBe(63 / 64)
  })

  it("replays the full response without dispatch and persists integer savings and genuine tags", async () => {
    const db = join(directory, "ledger.db"), mik = await hub({ approximate: true }, db)
    try {
      const start = calls, first = await mik.generate(request())
      const replay = await mik.generate({ ...request(changed), traceId: "approx-trace", sessionId: "approx-session" })
      expect(calls - start).toBe(1)
      expect(replay).toEqual({ ...first, cacheHit: true, latencyMs: 0, firstTokenMs: 0, cost: { ...first.cost, usd: 0, low: 0, high: 0 } })
      const event = mik.usage.query().events.find(event => event.cacheHit)!
      expect(event).toMatchObject({ costMicros: 0, stepCacheSavingsMicros: 35, traceId: "approx-trace", sessionId: "approx-session",
        tags: { _mik_local_cache_hit: "true", _mik_approx_cache_hit: "true", _mik_approx_similarity: "0.984375" } })
    } finally { await mik.close() }
    const store = await Store.open({ path: db })
    try {
      expect(store.driver.prepare("SELECT cost_micros, cache_savings_micros, typeof(cache_savings_micros) AS kind FROM usage_events WHERE cache_savings_micros = 35").get())
        .toMatchObject({ cost_micros: 0, cache_savings_micros: 35, kind: "integer" })
      expect(JSON.stringify(store.driver.prepare("SELECT * FROM response_cache").all())).not.toContain("word0")
    } finally { store.close() }
    const reopened = await hub({ approximate: true }, db)
    try {
      const start = calls
      expect((await reopened.generate(request(changed))).cacheHit).not.toBe(true)
      expect(calls - start).toBe(1)
      expect((await reopened.generate(request())).cacheHit).toBe(true)
    } finally { await reopened.close() }
  })

  it.each(["0.95", "0.98", "", "abc", "NaN", "-1", "0", "1.5", "Infinity", "   "])("uses the default or valid threshold %j", async threshold => {
    const mik = await hub()
    try {
      const start = calls
      await mik.generate(request())
      expect((await mik.generate({ ...request(changed), headers: { "X-Mik-Approx-Threshold": threshold } })).cacheHit).toBe(true)
      expect(calls - start).toBe(1)
    } finally { await mik.close() }
  })

  it.each(["0.99", "1"])("filters below threshold %s and strips the header upstream", async threshold => {
    const mik = await hub()
    try {
      const start = calls
      await mik.generate(request())
      expect((await mik.generate({ ...request(changed), headers: { "X-Mik-Approx-Threshold": threshold } })).cacheHit).not.toBe(true)
      expect(calls - start).toBe(2)
      expect(receivedHeaders["x-mik-approx-threshold"]).toBeUndefined()
    } finally { await mik.close() }
  })

  it.each([{}, { approximate: false }, false] as const)("defaults approximate off with %j", async cache => {
    const mik = await hub(cache)
    try {
      await mik.generate(request())
      expect((await mik.generate(request(changed))).cacheHit).not.toBe(true)
    } finally { await mik.close() }
  })

  it.each(isolatedRequests)("keeps request safety and parameter isolation %j", async options => {
    const mik = await hub()
    try {
      const start = calls
      await mik.generate(request())
      expect((await mik.generate({ ...request(changed), ...options })).cacheHit).not.toBe(true)
      expect(calls - start).toBe(2)
    } finally { await mik.close() }
  })

  it("dispatches low overlap, isolates apps and strips spoofed diagnostic tags", async () => {
    const mik = await hub()
    try {
      const start = calls
      await mik.usage.withAppScope("a", () => mik.generate(request()))
      expect((await mik.usage.withAppScope("b", () => mik.generate(request(changed)))).cacheHit).not.toBe(true)
      expect((await mik.usage.withAppScope("a", () => mik.generate(request(changed)))).cacheHit).toBe(true)
      const result = await mik.generate({ ...request("unrelated dinner recipe"), tags: { _mik_approx_cache_hit: "true", _mik_approx_similarity: "1" } })
      expect(result.cacheHit).not.toBe(true)
      expect(calls - start).toBe(3)
      expect(mik.usage.query().events.filter(event => !event.cacheHit).every(event => !event.tags?._mik_approx_cache_hit && !event.tags?._mik_approx_similarity)).toBe(true)
    } finally { await mik.close() }
  })

  it("does not seed approximate lookup from tool calls, multiple turns or nonzero/omitted temperature", async () => {
    for (const options of [
      { tools: { inspect: tool({ inputSchema: jsonSchema({ type: "object" }) }) } },
      { messages: [{ role: "assistant", content: "earlier response" }, ...request().messages] },
      { temperature: undefined, cache: true }, { temperature: 1, cache: true },
    ] satisfies Partial<ModelRequest>[]) {
      const mik = await hub()
      try {
        const first = await mik.generate({ ...request(), ...options })
        if (options.tools) expect(first.toolCalls).toHaveLength(1)
        const start = calls
        expect((await mik.generate(request(changed))).cacheHit).not.toBe(true)
        expect(calls - start).toBe(1)
      } finally { await mik.close() }
    }
  })

  it("shares approximate replay across stream and generate without forwarding the control header", async () => {
    const mik = await hub()
    try {
      const start = calls
      for await (const _ of mik.stream({ ...request(), headers: { "x-mik-approx-threshold": "0.95" } })) { /* drain */ }
      expect(receivedHeaders["x-mik-approx-threshold"]).toBeUndefined()
      const events = []
      for await (const event of mik.stream(request(changed))) events.push(event)
      expect(events.map(event => event.type)).toEqual(["text_delta", "step_finish", "usage", "finish"])
      expect(events.at(-1)).toMatchObject({ response: { cacheHit: true, text: "fixture answer", cost: { usd: 0, low: 0, high: 0 } } })
      expect((await mik.generate(request(changed))).cacheHit).toBe(true)
      expect(calls - start).toBe(1)
    } finally { await mik.close() }
  })

  it("expires signatures at the fixed TTL and bounds the index by capacity", async () => {
    const mik = await hub({ approximate: true, ttlMs: 10_000, maxEntries: 1 })
    try {
      await mik.generate(request())
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_000)
      try { expect((await mik.generate(request(changed))).cacheHit).not.toBe(true) } finally { clock.mockRestore() }
      await mik.generate(request("different topic for eviction"))
      expect((await mik.generate(request())).cacheHit).not.toBe(true)
    } finally { await mik.close() }
  })
})
