import { createServer as httpServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/index.js"
import { Store } from "../src/store/database.js"
import { tool, jsonSchema } from "ai"

let calls = 0
let upstreamUrl = ""
const directory = mkdtempSync(join(tmpdir(), "mik-g130-"))
const upstream = httpServer(async (req, res) => {
  let text = ""
  for await (const part of req) text += part
  const body = JSON.parse(text)
  calls++
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } }
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const frame of [
      { choices: [{ index: 0, delta: { content: "cached answer" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ]) res.write(`data: ${JSON.stringify({ id: "g130", object: "chat.completion.chunk", created: 1, model: "model", ...frame })}\n\n`)
    res.end("data: [DONE]\n\n")
  } else {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "g130", object: "chat.completion", created: 1, model: "model",
      choices: [{ index: 0, message: body.messages[0]?.content === "tool fixture"
        ? { role: "assistant", content: null, tool_calls: [{ id: "call-g130", type: "function", function: { name: "inspect", arguments: '{"b":2,"a":1}' } }] }
        : { role: "assistant", content: "cached answer" }, finish_reason: body.messages[0]?.content === "tool fixture" ? "tool_calls" : "stop" }], usage }))
  }
})
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())) })

async function hub(db = ":memory:", cache: false | { ttlMs?: number; maxEntries?: number } = {}) {
  const result = await ModelInfra.init({ db, cache, cacheDir: directory, syncCatalog: false, pricingAutoSync: false,
    env: { G130_KEY: "fixture-credential" }, providers: [{ id: "test", baseUrl: upstreamUrl, apiKeyRef: "env:G130_KEY" }],
    defaultModel: "test:model", pricingFetch: async () => { throw new Error("offline") } })
  result.pricing.setOverride({ modelId: "model", inputPerM: 2, outputPerM: 3, cacheReadPerM: 0.5 })
  return result
}
const request = (content = "hello world") => ({ messages: [{ role: "user" as const, content }], temperature: 0 })

describe("real cache gateway replay and integer ledger", () => {
  it("replays non-executing tool calls and token usage without dispatch", async () => {
    const mik = await hub()
    try {
      const start = calls
      const tools = { inspect: tool({ description: "inspect", inputSchema: jsonSchema({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }) }) }
      const first = await mik.generate({ ...request("tool fixture"), tools })
      const replay = await mik.generate({ ...request("tool fixture"), tools })
      expect(first.toolCalls).toHaveLength(1)
      expect(replay.toolCalls).toEqual(first.toolCalls)
      expect(replay.usage).toEqual(first.usage)
      expect(replay.cacheHit).toBe(true)
      expect(calls - start).toBe(1)
    } finally { await mik.close() }
  })
  it("normalizes generate, sends no request on hit, charges zero and saves full input+output", async () => {
    const mik = await hub()
    try {
      const start = calls
      const first = await mik.generate(request())
      const second = await mik.generate(request("  hello\n  world "))
      expect(calls - start).toBe(1)
      expect(second).toMatchObject({ text: first.text, usage: first.usage, latencyMs: 0, firstTokenMs: 0, cacheHit: true, cost: { usd: 0, low: 0, high: 0 } })
      const hit = mik.usage.query().events.find(event => event.cacheHit)!
      expect(hit.costMicros).toBe(0)
      expect(hit.stepCacheSavingsMicros).toBe(35)
      expect(mik.usage.summary()).toMatchObject({ localCacheHits: 1, localCacheHitRate: 0.5, cacheSavingsMicros: 41 })
      expect(first.cost.usd).toBe(0.000029)
    } finally { await mik.close() }
  })
  it("cold stream populates cache, then stream and generate share completed replay", async () => {
    const mik = await hub()
    try {
      const start = calls
      const first = []
      for await (const event of mik.stream(request())) first.push(event)
      const second = []
      for await (const event of mik.stream(request())) second.push(event)
      expect(calls - start).toBe(1)
      expect(second.find(event => event.type === "finish")).toMatchObject({ response: { text: "cached answer", cacheHit: true, latencyMs: 0 } })
      expect(second.map(event => event.type)).toEqual(["text_delta", "step_finish", "usage", "finish"])
      expect((await mik.generate(request())).cacheHit).toBe(true)
      expect(mik.usage.query().events.filter(event => event.cacheHit)).toHaveLength(2)
    } finally { await mik.close() }
  })
  it("HTTP completions and SSE replay; no-cache header always dispatches", async () => {
    const mik = await hub()
    const server = await createServer({ hub: mik, port: 0, token: "local-fixture-access" })
    try {
      const start = calls
      const send = (body = {}, headers = {}) => fetch(`${server.url}/v1/chat/completions`, { method: "POST",
        headers: { Authorization: "Bearer local-fixture-access", "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "test:model", ...request(), ...body }) })
      expect((await send()).status).toBe(200)
      const hit = await (await send()).json()
      expect(hit.x_modelhub).toMatchObject({ cache_hit: true, latency_ms: 0 })
      const sse = await (await send({ stream: true, stream_options: { include_usage: true } })).text()
      expect(sse).toContain("cached answer"); expect(sse).toContain("[DONE]")
      expect(calls - start).toBe(1)
      expect((await send({}, { "X-Mik-No-Cache": "true" })).status).toBe(200)
      expect(calls - start).toBe(2)
      expect(mik.usage.query().events.filter(event => event.cacheHit).every(event => event.costMicros === 0 && event.stepCacheSavingsMicros === 35)).toBe(true)
    } finally { await server.close(); await mik.close() }
  })
  it("stochastic, disabled, explicit bypass and executable tool calls never reuse", async () => {
    for (const cache of [{}, false] as const) {
      const mik = await hub(":memory:", cache)
      try {
        const start = calls
        const value = { ...request(), ...(cache === false ? {} : { temperature: 1 }) }
        await mik.generate(value); await mik.generate(value)
        expect(calls - start).toBe(2)
        if (cache !== false) {
          const startTools = calls
          const tools = { inspect: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "ok" }) }
          await mik.generate({ ...request(), tools }); await mik.generate({ ...request(), tools })
          expect(calls - startTools).toBe(2)
          const explicit = await mik.generate({ ...request(), temperature: undefined, cache: true })
          expect(explicit.cacheHit).not.toBe(true)
          expect((await mik.generate({ ...request(), temperature: undefined, cache: true })).cacheHit).toBe(true)
        }
      } finally { await mik.close() }
    }
  })
  it("persisted cache survives reopen; integer column and cache metadata contain no credential", async () => {
    const db = join(directory, "persistent.db")
    const mik = await hub(db)
    await mik.generate(request())
    await mik.generate(request())
    await mik.close()
    const store = await Store.open({ path: db })
    try {
      const hit = store.driver.prepare("SELECT cost_micros, cache_savings_micros FROM usage_events WHERE latency_ms = 0 AND cache_savings_micros = 35").get()
      expect(hit).toMatchObject({ cost_micros: 0, cache_savings_micros: 35 })
      const rows = store.driver.prepare("SELECT * FROM response_cache").all()
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain("fixture-credential")
      expect(JSON.stringify(rows)).not.toContain("hello world")
    } finally { store.close() }
    const reopened = await ModelInfra.init({ db, cacheDir: directory, syncCatalog: false, pricingAutoSync: false, env: { G130_KEY: "fixture-credential" } })
    try {
      const start = calls
      expect((await reopened.generate(request())).cacheHit).toBe(true)
      expect(calls - start).toBe(0)
    } finally { await reopened.close() }
  })
  it("request-local app attribution isolates cache entries", async () => {
    const mik = await hub()
    try {
      await mik.usage.withAppScope("a", () => mik.generate(request()))
      expect((await mik.usage.withAppScope("b", () => mik.generate(request()))).cacheHit).not.toBe(true)
      expect((await mik.usage.withAppScope("a", () => mik.generate(request()))).cacheHit).toBe(true)
    } finally { await mik.close() }
  })
})
