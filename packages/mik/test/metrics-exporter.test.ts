import { createServer as nodeServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer, type ServerHandle } from "../src/server/server.js"
import { MetricsExporter, METRICS_CONTENT_TYPE } from "../src/server/metrics.js"
import { ModelInfraError } from "../src/errors.js"
import type { UsageEvent } from "../src/types.js"

let upstreamUrl = ""
let failPrimary = false
const cacheDir = mkdtempSync(join(tmpdir(), "mik-metrics-"))
const hubs: ModelInfra[] = []
const servers: ServerHandle[] = []
const upstream = nodeServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const stream = !!JSON.parse(body).stream
  if (failPrimary && req.url?.startsWith("/primary")) {
    res.writeHead(503, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "sensitive prompt sk-secret-upstream", type: "server_error" } }))
    return
  }
  const common = { id: "metric", object: stream ? "chat.completion.chunk" : "chat.completion", created: 1, model: "model" }
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 }, cost: 0.000123 }
  res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" })
  if (!stream) res.end(JSON.stringify({ ...common, choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage }))
  else res.end([
    { ...common, choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")
})
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const hub of hubs.splice(0)) await hub.close()
  failPrimary = false
})
afterAll(async () => { await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() }) })
async function setup(enabled = true) {
  const onUsage = vi.fn()
  const hub = await ModelInfra.init({ appId: "host", db: ":memory:", cacheDir, syncCatalog: false, pricingAutoSync: false,
    pricingFetch: async () => { throw new Error("offline") }, maxRetries: 0, onWarn: () => {}, onUsage,
    recordUsage: enabled, failover: { failureThreshold: 1, cooldownMs: 60_000 },
    providers: [{ id: "primary", protocol: "openai-compatible", baseUrl: upstreamUrl + "/primary", fallback_provider_id: "backup" },
      { id: "backup", protocol: "openai-compatible", baseUrl: upstreamUrl + "/backup" }],
  })
  hubs.push(hub)
  const server = await createServer({ hub, port: 0, tokens: [
    { token: "read-a", scopes: ["read:usage"], appId: "a" }, { token: "read-b", scopes: ["read:usage"], appId: "b" },
    { token: "chat-a", scopes: ["write:chat"], appId: "a" }, { token: "chat-b", scopes: ["write:chat"], appId: "b" },
    { token: "master", scopes: ["admin"] },
  ] })
  servers.push(server)
  return { hub, server, onUsage }
}
async function scrape(server: ServerHandle, token = "read-a") {
  const response = await fetch(server.url + "/metrics", { headers: { authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE)
  return response.text()
}
function value(text: string, name: string, includes: string[] = []): bigint {
  return text.split("\n").filter(line => line.startsWith(name + "{") && includes.every(part => line.includes(part)))
    .reduce((sum, line) => sum + BigInt(line.slice(line.lastIndexOf(" ") + 1)), 0n)
}
function record(id: string, extra: Partial<UsageEvent> = {}): UsageEvent {
  return { requestId: id, appId: "a", ts: 1, providerId: "primary", modelActual: "model", modelRequested: "primary:model", source: "test",
    usage: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1 }, cost: { usd: 0.000123, low: 0.000123, high: 0.000123, basis: "exact", source: "provider" }, latencyMs: 100,
    status: "ok", isStreaming: false, ...extra }
}
async function chat(server: ServerHandle, token: string, stream = false) {
  const response = await fetch(server.url + "/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "primary:model", messages: [{ role: "user", content: "do not label my private prompt" }], stream }) })
  expect(response.status).toBe(200)
  await response.text()
}

describe("G111 native Prometheus exporter", () => {
  it("returns valid empty HELP/TYPE families and protects read:usage", async () => {
    const { server } = await setup()
    expect((await fetch(server.url + "/metrics")).status).toBe(401)
    expect((await fetch(server.url + "/metrics", { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    const denied = await fetch(server.url + "/metrics", { headers: { authorization: "Bearer chat-a" } })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: { message: "insufficient_scope", code: "FORBIDDEN" } })
    const text = await scrape(server)
    expect(text.match(/^# HELP /gm)).toHaveLength(5)
    expect(text.match(/^# TYPE /gm)).toHaveLength(5)
    expect(text).toContain("# TYPE mik_request_duration_seconds histogram")
    expect(text.split("\n").filter(line => line && !line.startsWith("#"))).toEqual([])
    expect((await fetch(server.url + "/metrics?app_id=b", { headers: { authorization: "Bearer read-a" } })).status).toBe(403)
  })

  it("counts 40 real concurrent generate/stream calls once, partitions tokens, isolates apps and ignores scrapes", async () => {
    const { hub, server } = await setup()
    await Promise.all(Array.from({ length: 40 }, (_, i) => chat(server, i < 30 ? "chat-a" : "chat-b", i % 2 === 0)))
    const text = await scrape(server)
    expect(value(text, "mik_requests_total", ['status="ok"'])).toBe(30n)
    expect(value(text, "mik_requests_total", ['status="error"'])).toBe(0n)
    expect(value(text, "mik_cost_micros_total")).toBe(3690n)
    expect(value(text, "mik_request_duration_seconds_count")).toBe(30n)
    expect(value(text, "mik_request_duration_seconds_bucket", ['le="+Inf"'])).toBe(30n)
    expect(value(text, "mik_tokens_total", ['type="prompt"'])).toBe(210n)
    expect(value(text, "mik_tokens_total", ['type="completion"'])).toBe(90n)
    expect(value(text, "mik_tokens_total", ['type="reasoning"'])).toBe(60n)
    expect(value(text, "mik_tokens_total", ['type="cache"'])).toBe(90n)
    expect(value(await scrape(server, "read-b"), "mik_cost_micros_total")).toBe(1230n)
    expect(value(await scrape(server, "master"), "mik_requests_total")).toBe(0n)
    expect(await scrape(server)).toBe(text)
    expect(text).not.toContain("private prompt")
    const summary = vi.spyOn(hub.usage, "summary").mockImplementation(() => { throw new Error("no scrape scans") })
    expect(await scrape(server)).toBe(text)
    expect(summary).not.toHaveBeenCalled()
  })

  it("reports real failed attempts, actual fallback costs and circuit health", async () => {
    const { hub, server } = await setup()
    failPrimary = true
    await chat(server, "chat-a")
    const text = await scrape(server)
    expect(value(text, "mik_requests_total", ['provider="primary"', 'status="error"'])).toBe(1n)
    expect(value(text, "mik_requests_total", ['provider="backup"', 'status="ok"'])).toBe(1n)
    expect(value(text, "mik_cost_micros_total", ['provider="primary"'])).toBe(0n)
    expect(value(text, "mik_cost_micros_total", ['provider="backup"'])).toBe(123n)
    expect(text).toContain('mik_provider_health_status{provider="primary"} 0')
    expect(text).toContain('mik_provider_health_status{provider="backup"} 1')
    expect(await scrape(server, "read-b")).not.toContain('provider="primary"')
    hub.providerHealth.success("primary")
    expect(await scrape(server)).toContain('mik_provider_health_status{provider="primary"} 1')
    expect(text).not.toContain("sensitive prompt")
    expect(text).not.toContain("sk-secret")
  })

  it("keeps runtime observation when persistence is disabled without changing onUsage", async () => {
    const { hub, server, onUsage } = await setup(false)
    await Promise.all([chat(server, "chat-a"), chat(server, "chat-a", true)])
    expect(value(await scrape(server), "mik_requests_total", ['status="ok"'])).toBe(2n)
    expect(hub.usage.query({ appId: "a" }).events).toHaveLength(0)
    expect(onUsage).not.toHaveBeenCalled()
  })

  it("uses cumulative boundaries, exact BigInt totals and does not repeat committed IDs", async () => {
    const { hub, server } = await setup()
    for (const [i, latencyMs] of [0, 50, 51, 100, 101, 250, 500, 1000, 2500, 5000, 10000, 10001].entries()) hub.usage.record(record(`boundary-${i}`, { latencyMs }))
    hub.usage.record(record("boundary-0"))
    let text = await scrape(server)
    for (const [le, expected] of [["0.05", 2n], ["0.1", 4n], ["0.25", 6n], ["0.5", 7n], ["1", 8n], ["2.5", 9n], ["5", 10n], ["10", 11n], ["+Inf", 12n]] as const) {
      expect(value(text, "mik_request_duration_seconds_bucket", [`le="${le}"`])).toBe(expected)
    }
    expect(value(text, "mik_request_duration_seconds_count")).toBe(12n)
    expect(text).toContain('mik_request_duration_seconds_sum{provider="primary",model="model",app_id="a"} 29.553')
    for (let i = 0; i < 3; i++) hub.usage.record(record(`big-${i}`, { cost: { usd: 9_000_000_000, low: 9_000_000_000, high: 9_000_000_000, basis: "exact", source: "provider" } }))
    text = await scrape(server)
    expect(value(text, "mik_cost_micros_total")).toBe(27_000_000_000_001_476n)
    hub.usage.record(record("above-safe", { cost: { usd: 10_000_000_000, low: 10_000_000_000, high: 10_000_000_000, basis: "exact", source: "provider" } }))
    expect(value(await scrape(server), "mik_cost_micros_total")).toBe(37_000_000_000_001_476n)
  })

  it("redacts known gateway secrets, escapes label syntax and preserves distinct tenant ownership", async () => {
    const { hub, server } = await setup()
    hub.usage.record(record("labels", { modelActual: 'quote"\\\nline sk-abcdef123456 master', tags: { prompt: "never-export-this" } }))
    const text = await scrape(server)
    expect(text).toContain('quote\\"\\\\\\nline sk-**** [REDACTED]')
    expect(text).not.toContain("abcdef123456")
    expect(text).not.toContain("master")
    expect(text).not.toContain("never-export-this")
    for (const line of text.split("\n").filter(line => line && !line.startsWith("#"))) {
      expect(line).toMatch(/^[a-z_]+\{(?:[a-z_]+="(?:[^"\\\n]|\\[\\"n])*"(?:,|(?=\})))*\} [0-9]+(?:\.[0-9]+)?$/)
    }
    const exporter = new MetricsExporter(hub)
    hub.usage.record(record("tenant1", { appId: "sk-one" }))
    hub.usage.record(record("tenant2", { appId: "sk-two", cost: { usd: 0.000456, low: 0.000456, high: 0.000456, basis: "exact", source: "provider" } }))
    expect(value(exporter.render("sk-one"), "mik_cost_micros_total")).toBe(123n)
    expect(value(exporter.render("sk-two"), "mik_cost_micros_total")).toBe(456n)
    expect(exporter.render("sk-one")).not.toEqual(exporter.render("sk-two"))
    exporter.close()
  })

  it("bounds model cardinality per app and retains all overflow costs in that app", async () => {
    const { hub } = await setup()
    const exporter = new MetricsExporter(hub)
    hub.usage.record(record("reserved", { providerId: "__other__", modelActual: "__other__" }))
    for (let i = 0; i < 1100; i++) hub.usage.record(record(`card-${i}`, { modelActual: `model-${i}` }))
    const text = exporter.render("a")
    expect(text.match(/^mik_cost_micros_total/gm)).toHaveLength(1025)
    expect(value(text, "mik_cost_micros_total")).toBe(135423n)
    expect(value(text, "mik_requests_total", ['status="ok"'])).toBe(1101n)
    const costLabels = text.split("\n").filter(line => line.startsWith("mik_cost_micros_total{")).map(line => line.slice(0, line.lastIndexOf(" ")))
    expect(new Set(costLabels).size).toBe(costLabels.length)
    expect(exporter.render("b")).not.toContain("__other__")
    exporter.close()
  })

  it("unsubscribes each closed exporter/server and reads HALF_OPEN without reserving a probe", async () => {
    const { hub, server } = await setup()
    const exporter = new MetricsExporter(hub)
    hub.usage.record(record("before"))
    exporter.close()
    hub.usage.record(record("after"))
    expect(value(exporter.render("a"), "mik_requests_total")).toBe(0n)
    const observe = vi.spyOn(hub.usage, "observe")
    const listener = vi.fn()
    const stop = vi.fn()
    observe.mockImplementation(fn => { listener.mockImplementation(fn); return stop })
    const second = await createServer({ hub, port: 0, tokens: [] })
    await second.close()
    await second.close()
    expect(stop).toHaveBeenCalledTimes(1)
    observe.mockRestore()
    await server.close()
    const clock = vi.spyOn(hub.providerHealth, "state").mockReturnValue("HALF_OPEN")
    const active = new MetricsExporter(hub)
    expect(active.render("host")).toContain('mik_provider_health_status{provider="primary"} 0')
    expect(clock).toHaveBeenCalled()
    active.close()
  })

  it("unsubscribes on a failed bind", async () => {
    const { hub } = await setup()
    const stop = vi.fn()
    const observe = vi.spyOn(hub.usage, "observe").mockReturnValue(stop)
    await expect(createServer({ hub, port: 0, host: "256.256.256.256", tokens: [] })).rejects.toBeInstanceOf(ModelInfraError)
    expect(stop).toHaveBeenCalledTimes(1)
    observe.mockRestore()
  })

  it("measures a typical ten-series in-memory scrape without database queries", async () => {
    const { hub } = await setup()
    const exporter = new MetricsExporter(hub)
    for (let i = 0; i < 10; i++) hub.usage.record(record(`perf-${i}`, { modelActual: `model-${i}` }))
    for (let i = 0; i < 50; i++) exporter.render("a")
    const timings: number[] = []
    for (let i = 0; i < 1000; i++) {
      const start = performance.now()
      const result = exporter.render("a")
      timings.push(performance.now() - start)
      expect(result).toContain("# TYPE mik_cost_micros_total counter")
    }
    timings.sort((a, b) => a - b)
    process.stdout.write(`G111 render 10 series / 1000 scrapes: median=${timings[500]!.toFixed(3)}ms p95=${timings[950]!.toFixed(3)}ms\n`)
    exporter.close()
  })
})
