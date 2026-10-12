import { createServer as httpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/server.js"
import { NOTIFICATION_EVENTS } from "../src/events/bus.js"
import { verifyWebhookSignature } from "../src/events/webhook.js"
import { DatabaseSync } from "node:sqlite"

const directory = mkdtempSync(join(tmpdir(), "mik-g134-")), received: Array<Record<string, unknown>> = []
let upstreamUrl = "", receiverUrl = "", pending = 0, failures = false
const receiver = httpServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  expect(verifyWebhookSignature("signing-secret", String(req.headers["x-mik-timestamp"]), body, String(req.headers["x-mik-signature"]))).toBe(true)
  received.push(JSON.parse(body))
  pending++
  // A truly hanging peer. Close destroys the connection; no30s test delay.
  if (req.url === "/hang") return
  res.writeHead(failures ? 500 : 204); res.end()
})
const upstream = httpServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  if (req.url?.startsWith("/bad")) { res.writeHead(503); res.end(); return }
  if (req.url?.startsWith("/rate")) { res.writeHead(429); res.end(); return }
  if (JSON.parse(body).stream) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ]) res.write(`data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", created: 1, model: "model", ...chunk })}\n\n`)
    res.end("data: [DONE]\n\n")
    return
  }
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ id: "g134", object: "chat.completion", created: 1, model: "model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }))
})
beforeAll(async () => {
  for (const server of [receiver, upstream]) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterAll(async () => {
  for (const server of [receiver, upstream]) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
async function fixture(path = "/ok", extra: Parameters<typeof ModelInfra.init>[0] = {}) {
  const hub = await ModelInfra.init({ appId: "app", db: ":memory:", cache: false, cacheDir: directory, syncCatalog: false,
    pricingAutoSync: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {},
    env: { KEY: "plain-provider-secret" }, providers: [{ id: "p", baseUrl: upstreamUrl, apiKeyRef: "env:KEY" }], defaultModel: "p:model",
    webhooks: [{ url: receiverUrl + path, secret: "signing-secret", events: [...NOTIFICATION_EVENTS], timeoutMs: 30000, maxRetries: 0 }], ...extra })
  hub.pricing.setOverride({ modelId: "model", inputPerM: 1, outputPerM: 1 })
  return hub
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }

describe("notification integration", () => {
  it("retiring the initial external hub on reload cancels its hanging delivery", async () => {
    const db = join(directory, "reload.db"), configPath = join(directory, "reload.json")
    writeFileSync(configPath, "{}")
    const hub = await fixture("/hang", { db }), server = await createServer({ hub, port: 0,
      reload: { configPath, watch: false, env: { KEY: "plain-provider-secret" }, hubOptions: { appId: "app", db, cacheDir: directory, cache: false,
        syncCatalog: false, pricingAutoSync: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {} } } })
    try {
      await hub.generate({ messages: [{ role: "user", content: "hello" }] })
      await waitFor(() => hub.webhooks.status().active > 0)
      expect((await server.reloadConfig()).reloaded).toBe(true)
      await waitFor(() => hub.webhooks.status().closed)
      expect(hub.webhooks.status()).toMatchObject({ active: 0, queued: 0, retrying: 0 })
    } finally { await server.close(); await hub.close() }
  })
  it("notifies failed streaming fallback attempts and upstream provider429", async () => {
    const start = received.length, hub = await fixture("/ok", { maxRetries: 0, fallbackChain: ["bad2:model"], defaultModel: "bad:model",
      providers: [{ id: "bad", baseUrl: upstreamUrl + "/bad", apiKeyRef: "env:KEY" }, { id: "bad2", baseUrl: upstreamUrl + "/bad", apiKeyRef: "env:KEY" }] })
    try {
      for await (const _event of hub.stream({ messages: [{ role: "user", content: "hello" }] })) { /* consume error */ }
      await waitFor(() => received.slice(start).some(event => event.type === "FAILOVER_TRIGGERED"))
    } finally { await hub.close() }
    const rate = await fixture("/ok", { maxRetries: 0, providers: [{ id: "p", baseUrl: upstreamUrl + "/rate", apiKeyRef: "env:KEY" }] }), before = received.length
    try {
      await expect(rate.generate({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow()
      await waitFor(() => received.slice(before).some(event => event.type === "RATE_LIMITED"))
    } finally { await rate.close() }
  })
  it("real embedded and HTTP generation complete while a30s receiver remains hanging; close cancels", async () => {
    const hub = await fixture("/hang"), server = await createServer({ hub, port: 0 })
    try {
      const start = performance.now()
      expect((await hub.generate({ messages: [{ role: "user", content: "hello" }] })).text).toBe("ok")
      await waitFor(() => hub.webhooks.status().active > 0)
      const httpStart = performance.now()
      const response = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "p:model", messages: [{ role: "user", content: "hi" }] }) })
      expect(response.status).toBe(200)
      expect((await response.json()).choices[0].message.content).toBe("ok")
      expect(performance.now() - httpStart).toBeLessThan(2000)
      expect(performance.now() - start).toBeLessThan(3000)
      expect(hub.webhooks.status().delivered).toBe(0)
      const streamStart = performance.now(), events = []
      for await (const event of hub.stream({ messages: [{ role: "user", content: "stream" }] })) events.push(event)
      expect(events.some(event => event.type === "finish")).toBe(true)
      expect(performance.now() - streamStart).toBeLessThan(2000)
      expect(pending).toBeGreaterThan(0)
      const closeStart = performance.now()
      await server.close()
      expect(hub.webhooks.status()).toMatchObject({ closed: true, active: 0, retrying: 0 })
      expect(performance.now() - closeStart).toBeLessThan(1000)
    } finally { await server.close(); await hub.close() }
  })
  it("reads authoritative Schema v7 beyond Number precision and excludes duplicate/disabled rows", async () => {
    const db = join(directory, "integer.db"), hub = await fixture("/ok", { db }), start = received.length
    try {
      const event = { requestId: "exact", ts: Date.now(), source: "test", providerId: "p", modelRequested: "model", modelActual: "model",
        usage: zero, cost: { usd: 0, low: 0, high: 0, basis: "exact" as const, source: "manual" as const }, status: "ok" as const, isStreaming: false }
      expect(hub.usage.record(event)).toBe(true)
      expect(hub.usage.record(event)).toBe(false)
      const store = new DatabaseSync(db)
      try { store.prepare("UPDATE usage_events SET cost_micros=?, cache_savings_micros=? WHERE request_id='exact'").run(9007199254740993n, 9007199254740995n) } finally { store.close() }
      const exact = () => received.slice(start).filter(event => (event.data as Record<string, unknown>).requestId === "exact")
      await waitFor(() => exact().length > 0)
      expect(exact()[0]).toMatchObject({ type: "USAGE_RECORDED", data: { costMicros: "9007199254740993", cacheSavingsMicros: "9007199254740995" } })
      await tick()
      expect(exact()).toHaveLength(1)
    } finally { await hub.close() }
    const disabled = await fixture("/ok", { recordUsage: false }), before = received.length
    try {
      await disabled.generate({ messages: [{ role: "user", content: "hello" }] })
      await tick(); await tick()
      expect(received.length).toBe(before)
    } finally { await disabled.close() }
  })
  it("authenticates admin endpoints and emits tenant rate and hard-budget alerts", async () => {
    const hub = await fixture(), server = await createServer({ hub, port: 0,
      quotas: { applications: [{ appId: "app", maxRpm: 1 }] }, tokens: [
        { token: "chat-credential", scopes: ["write:chat", "read:usage"], appId: "app" }, { token: "admin-credential", scopes: ["admin"] }] })
    const start = received.length
    try {
      for (const path of ["status", "test"]) {
        const response = await fetch(server.url + "/api/webhooks/" + path, { method: path === "test" ? "POST" : "GET", headers: { authorization: "Bearer chat-credential" } })
        expect(response.status).toBe(403)
      }
      const test = await fetch(server.url + "/api/webhooks/test", { method: "POST", headers: { authorization: "Bearer admin-credential" }, body: JSON.stringify({ url: "http://169.254.169.254/", token: "raw" }) })
      expect(test.status).toBe(202)
      const post = () => fetch(server.url + "/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer chat-credential", "content-type": "application/json" }, body: JSON.stringify({ model: "p:model", messages: [{ role: "user", content: "hi" }] }) })
      expect((await post()).status).toBe(200)
      expect((await post()).status).toBe(429)
      await waitFor(() => received.slice(start).some(event => event.type === "RATE_LIMITED"))
      expect(JSON.stringify(received.slice(start))).not.toMatch(/plain-provider-secret|chat-credential|admin-credential/)
    } finally { await server.close(); await hub.close() }
    const budgetHub = await fixture(), budgetServer = await createServer({ hub: budgetHub, port: 0, budget: { dailyMicros: 1, hardCap: true }, tokens: [{ token: "chat", scopes: ["write:chat"] }] })
    try {
      budgetHub.usage.record({ requestId: "budget", ts: Date.now(), source: "test", providerId: "p", modelRequested: "m", modelActual: "m", usage: zero,
        cost: { usd: .000001, low: .000001, high: .000001, basis: "exact", source: "manual" }, status: "ok", isStreaming: false })
      const response = await fetch(budgetServer.url + "/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer chat" } })
      expect(response.status).toBe(429)
      await waitFor(() => received.some(event => event.type === "BUDGET_EXCEEDED"))
    } finally { await budgetServer.close(); await budgetHub.close() }
  })
  it("emits failover notifications with the successfully recorded fallback", async () => {
    const start = received.length, hub = await fixture("/ok", { maxRetries: 0, fallbackChain: ["p:model"], defaultModel: "bad:model",
      providers: [{ id: "bad", baseUrl: upstreamUrl + "/bad", apiKeyRef: "env:KEY" }, { id: "p", baseUrl: upstreamUrl, apiKeyRef: "env:KEY" }] })
    try {
      expect((await hub.generate({ messages: [{ role: "user", content: "hello" }] })).text).toBe("ok")
      await waitFor(() => received.slice(start).some(event => event.type === "FAILOVER_TRIGGERED"))
    } finally { await hub.close() }
  })
})
