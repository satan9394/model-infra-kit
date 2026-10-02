import { createServer, type ServerResponse } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { jsonSchema, tool } from "ai"
import { ProviderCircuitBreaker, isRetryableRouteFailure } from "../src/ai/failover.js"
import { ModelInfraError, toModelInfraError } from "../src/errors.js"
import { ModelInfra } from "../src/hub.js"
import { createServer as createGateway } from "../src/server/server.js"
import type { ModelRequest, ProviderConfig, StreamEvent } from "../src/types.js"

const calls = new Map<string, number>()
const statuses = new Map<string, number>()
const hubs: ModelInfra[] = []
let baseUrl = ""
let cacheDir = ""
let clock = 1_000
let heldResponse: ServerResponse | undefined
let holdPrimary = false
let emitThenError = false
let toolThenError = false
const messages: ModelRequest["messages"] = [{ role: "user", content: "ping" }]
function completion(stream: boolean): string {
  const common = { id: "g109", object: stream ? "chat.completion.chunk" : "chat.completion", created: 1, model: "shared-model" }
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.000123 }
  if (!stream) return JSON.stringify({ ...common, choices: [{ index: 0, message: { role: "assistant", content: "backup answer" }, finish_reason: "stop" }], usage })
  return [
    { ...common, choices: [{ index: 0, delta: { content: "backup answer" }, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
  ].map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n"
}
const upstream = createServer(async (req, res) => {
  const id = req.url!.split("/")[1]!
  calls.set(id, (calls.get(id) ?? 0) + 1)
  let body = ""
  for await (const chunk of req) body += chunk
  const stream = !!JSON.parse(body).stream
  if (toolThenError && id === "primary" && calls.get(id) === 1) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "tool-step", object: "chat.completion", created: 1, model: "shared-model", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call1", type: "function", function: { name: "sideEffect", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  if (holdPrimary && id === "primary") { heldResponse = res; return }
  if (emitThenError && id === "primary" && stream) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('data: {"id":"partial","model":"shared-model","choices":[{"index":0,"delta":{"content":"already emitted"},"finish_reason":null}]}\n\ndata: {"error":{"message":"timeout","type":"server_error"}}\n\n')
    return
  }
  const status = statuses.get(id) ?? 200
  res.writeHead(status, { "content-type": stream && status === 200 ? "text/event-stream" : "application/json" })
  res.end(status === 200 ? completion(stream) : JSON.stringify({ error: { message: "timeout rate limit sk-secret-g109-123456", type: "upstream_error" } }))
})
beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "mik-g109-"))
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
beforeEach(() => { calls.clear(); statuses.clear(); clock = 1_000; holdPrimary = false; emitThenError = false; toolThenError = false })
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.close() })
afterAll(async () => { await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())) })
async function hub(extra: ProviderConfig[] = []): Promise<ModelInfra> {
  const instance = await ModelInfra.init({
    db: ":memory:", cacheDir, syncCatalog: false, pricingAutoSync: false,
    pricingFetch: async () => { throw new Error("offline") }, maxRetries: 0, onWarn: () => {},
    failover: { failureThreshold: 1, cooldownMs: 100, now: () => clock },
    providers: [
      { id: "primary", baseUrl: `${baseUrl}/primary`, group: "shared", priority: 0 },
      { id: "backup", baseUrl: `${baseUrl}/backup`, group: "shared", priority: 1 }, ...extra,
    ],
  })
  hubs.push(instance)
  return instance
}
async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

describe("G109 passive provider failover", () => {
  it.each([429, 500, 502, 503, 504])("fails over HTTP %s once and bills the successful provider", async (status) => {
    statuses.set("primary", status)
    const mik = await hub()
    const response = await mik.generate({ model: "primary:shared-model", messages, traceId: "g109" })
    expect(response.provider).toBe("backup")
    expect(Math.round(response.cost.usd * 1_000_000)).toBe(123)
    expect(calls.get("primary")).toBe(1)
    expect(calls.get("backup")).toBe(1)
    const rows = mik.usage.query().events
    expect(rows.find((row) => row.status === "error")?.cost.usd).toBe(0)
    expect(rows.find((row) => row.status === "ok")).toMatchObject({ providerId: "backup", tags: { failover: "true", original_provider: "primary" } })
  })
  it("streams the backup after a real HTTP 429 without exposing the suppressed error", async () => {
    statuses.set("primary", 429)
    const mik = await hub()
    const events = await collect(mik.stream({ model: "primary:shared-model", messages }))
    expect(events.filter((event) => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "backup answer" }])
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "finish", response: { provider: "backup" } })
    expect(mik.usage.query().events.find((row) => row.status === "ok")?.tags).toMatchObject({ failover: "true", original_provider: "primary" })
  })
  it.each([400, 401, 403, 404, 408, 422])("never retries HTTP %s despite misleading timeout/rate-limit prose", async (status) => {
    statuses.set("primary", status)
    const mik = await hub()
    await expect(mik.generate({ model: "primary:shared-model", messages })).rejects.toMatchObject({ status })
    const events = await collect(mik.stream({ model: "primary:shared-model", messages }))
    expect(events.at(-1)?.type).toBe("error")
    expect(calls.has("backup")).toBe(false)
    expect(mik.providerHealth.state("primary")).toBe("CLOSED")
    expect(JSON.stringify(events)).not.toContain("sk-secret")
  })
  it("honors fallbackChain:false and tries no second automatic backup", async () => {
    statuses.set("primary", 503)
    const mik = await hub([{ id: "third", baseUrl: `${baseUrl}/third`, group: "shared", priority: 2 }])
    await expect(mik.generate({ model: "primary:shared-model", messages, fallbackChain: false })).rejects.toMatchObject({ status: 503 })
    expect(calls.has("backup")).toBe(false)
    clock += 101
    statuses.set("backup", 502)
    await expect(mik.generate({ model: "primary:shared-model", messages })).rejects.toMatchObject({ status: 502 })
    expect(calls.get("backup")).toBe(1)
    expect(calls.has("third")).toBe(false)
  })
  it("persists declarative fields and chooses explicit compatible fallback before group priority", async () => {
    const mik = await hub([{ id: "third", baseUrl: `${baseUrl}/third`, group: "other", priority: 2 }])
    mik.providers.add({ id: "primary", baseUrl: `${baseUrl}/primary`, group: "shared", priority: 0, fallback_provider_id: "third" })
    expect(mik.providers.get("primary")).toMatchObject({ group: "shared", priority: 0, fallback_provider_id: "third" })
    statuses.set("primary", 500)
    expect((await mik.generate({ model: "primary:shared-model", messages })).provider).toBe("third")
    expect(calls.has("backup")).toBe(false)
    expect(() => mik.providers.add({ id: "bad", baseUrl, priority: -1 })).toThrow("priority")
    expect(() => mik.providers.add({ id: "bad", baseUrl, fallback_provider_id: "bad" })).toThrow("different")
  })
  it("skips incompatible protocols and other groups", async () => {
    const mik = await hub()
    mik.providers.add({ id: "backup", protocol: "anthropic", baseUrl: `${baseUrl}/backup`, group: "shared" })
    statuses.set("primary", 503)
    await expect(mik.generate({ model: "primary:shared-model", messages })).rejects.toMatchObject({ status: 503 })
    expect(calls.has("backup")).toBe(false)
  })
  it("cooldown suppresses primary traffic and permits exactly one concurrent recovery probe", async () => {
    const mik = await hub()
    statuses.set("primary", 503)
    await mik.generate({ model: "primary:shared-model", messages })
    await mik.generate({ model: "primary:shared-model", messages })
    expect(calls.get("primary")).toBe(1)
    clock += 101
    holdPrimary = true
    const probe = mik.generate({ model: "primary:shared-model", messages })
    while (!heldResponse) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(mik.providerHealth.state("primary")).toBe("HALF_OPEN")
    await mik.generate({ model: "primary:shared-model", messages })
    expect(calls.get("primary")).toBe(2)
    heldResponse.writeHead(200, { "content-type": "application/json" })
    heldResponse.end(completion(false)); heldResponse = undefined
    expect((await probe).provider).toBe("primary")
    expect(mik.providerHealth.state("primary")).toBe("CLOSED")
  })
  it("does not replay after a stream has emitted text", async () => {
    const mik = await hub()
    emitThenError = true
    const events = await collect(mik.stream({ model: "primary:shared-model", messages }))
    expect(events.some((event) => event.type === "text_delta")).toBe(true)
    expect(events.at(-1)?.type).toBe("error")
    expect(calls.has("backup")).toBe(false)
  })
  it("does not replay generation after a completed tool step has caused a side effect", async () => {
    const mik = await hub()
    toolThenError = true; statuses.set("primary", 503)
    let executions = 0
    await expect(mik.generate({ model: "primary:shared-model", messages, tools: {
      sideEffect: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async () => { executions += 1; return "done" } }),
    } })).rejects.toMatchObject({ status: 503 })
    expect(executions).toBe(1)
    expect(calls.get("primary")).toBe(2)
    expect(calls.has("backup")).toBe(false)
  })
  it("does not replay a failed tool side effect after a later provider failure", async () => {
    const mik = await hub()
    toolThenError = true; statuses.set("primary", 503)
    let executions = 0
    await expect(mik.generate({ model: "primary:shared-model", messages, tools: {
      sideEffect: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async (): Promise<string> => {
        executions += 1
        throw new ModelInfraError("tool side effect failed", { status: 503, code: "PROVIDER", retryable: true })
      } }),
    } })).rejects.toBeInstanceOf(ModelInfraError)
    expect(executions).toBe(1)
    expect(calls.has("backup")).toBe(false)
  })
  it("releases a half-open streaming probe on consumer early return", async () => {
    const mik = await hub()
    statuses.set("primary", 500)
    await mik.generate({ model: "primary:shared-model", messages })
    clock += 101; statuses.set("primary", 200)
    for await (const event of mik.stream({ model: "primary:shared-model", messages })) {
      if (event.type === "text_delta") break
    }
    expect(mik.providerHealth.state("primary")).toBe("OPEN")
    expect(mik.providerHealth.acquire("primary")).toBe(true)
    mik.providerHealth.release("primary")
  })
  it("recovers a previously-open backup using subsequent failover traffic", async () => {
    const mik = await hub()
    statuses.set("primary", 503); statuses.set("backup", 502)
    await expect(mik.generate({ model: "primary:shared-model", messages })).rejects.toMatchObject({ status: 502 })
    expect(mik.providerHealth.state("backup")).toBe("OPEN")
    clock += 101; statuses.set("backup", 200)
    expect((await mik.generate({ model: "primary:shared-model", messages })).provider).toBe("backup")
    expect(mik.providerHealth.state("backup")).toBe("CLOSED")
  })
  it("client abort releases the half-open probe without retrying or counting another failure", async () => {
    const mik = await hub()
    statuses.set("primary", 503)
    await mik.generate({ model: "primary:shared-model", messages })
    clock += 101; holdPrimary = true
    const controller = new AbortController()
    const pending = mik.generate({ model: "primary:shared-model", messages, signal: controller.signal })
    while (!heldResponse) await new Promise((resolve) => setTimeout(resolve, 1))
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(ModelInfraError)
    heldResponse.end(); heldResponse = undefined
    expect(calls.get("backup")).toBe(1)
    expect(mik.providerHealth.state("primary")).toBe("OPEN")
    expect(mik.providerHealth.acquire("primary")).toBe(true)
    mik.providerHealth.release("primary")
  })
  it("the HTTP gateway inherits streamed failover and exact 401 rejection from the shared hub", async () => {
    const mik = await hub()
    const gateway = await createGateway({ hub: mik, port: 0, tokens: [] })
    try {
      statuses.set("primary", 429)
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "primary:shared-model", messages, stream: true }),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("backup answer")
      const updated = await fetch(`${gateway.url}/api/providers/primary`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ group: "shared", priority: 0, fallback_provider_id: "backup" }),
      })
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({ provider: { group: "shared", priority: 0, fallback_provider_id: "backup" } })
      const invalid = await fetch(`${gateway.url}/api/providers/primary`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ priority: "invalid" }),
      })
      expect(invalid.status).toBe(400)
      clock += 101; statuses.set("primary", 401)
      const rejected = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "primary:shared-model", messages }),
      })
      expect(rejected.status).toBe(401)
      expect(calls.get("backup")).toBe(1)
    } finally { await gateway.close() }
  })
  it("state machine resets consecutive failures, reopens failed probes and releases cancellation", () => {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 2, cooldownMs: 10, now: () => clock })
    const failure = new ModelInfraError("transient", { status: 503, retryable: true, code: "PROVIDER" })
    breaker.failure("a", failure); expect(breaker.state("a")).toBe("CLOSED")
    breaker.success("a"); breaker.failure("a", failure); expect(breaker.state("a")).toBe("CLOSED")
    breaker.failure("a", failure); expect(breaker.acquire("a")).toBe(false)
    clock += 10
    expect(breaker.acquire("a")).toBe(true); expect(breaker.acquire("a")).toBe(false)
    breaker.failure("a", failure); expect(breaker.state("a")).toBe("OPEN")
    clock += 10; expect(breaker.acquire("a")).toBe(true)
    breaker.release("a"); expect(breaker.acquire("a")).toBe(true)
  })
  it.each(["ETIMEDOUT", "ECONNREFUSED"])("classifies transport %s as recoverable", (code) => {
    expect(isRetryableRouteFailure(toModelInfraError(new Error(code)))).toBe(true)
  })
})
