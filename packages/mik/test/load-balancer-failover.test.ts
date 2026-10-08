import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { LoadBalancer, readLoadBalancerConfig } from "../src/router/load-balancer.js"
import { CircuitBreaker } from "../src/router/circuit-breaker.js"
import { ModelInfraError } from "../src/errors.js"
import { ModelInfra } from "../src/hub.js"
import { createServer as createGateway } from "../src/server/server.js"

let root = ""
let status = 200
let clock = 0
const calls: string[] = []
const hubs: ModelInfra[] = []
const messages = [{ role: "user" as const, content: "hello" }]
const upstream = createServer(async (req, res) => {
  const provider = req.url!.split("/")[1]!
  calls.push(provider)
  let body = ""
  for await (const chunk of req) body += chunk
  const streaming = JSON.parse(body).stream
  const code = provider === "a" ? status : 200
  res.writeHead(code, { "content-type": streaming && code === 200 ? "text/event-stream" : "application/json" })
  if (code !== 200) { res.end(JSON.stringify({ error: { message: "upstream unavailable" } })); return }
  const base = { id: "lb", model: "model", created: 1 }
  const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  res.end(streaming
    ? `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: provider }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`
    : JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: provider }, finish_reason: "stop" }], usage }))
})
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  root = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.close(); status = 200; clock = 0; calls.length = 0 })
afterAll(async () => { await new Promise<void>(resolve => upstream.close(() => resolve())) })
async function hub(weighted = false) {
  const hub = await ModelInfra.init({ db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-lb-")), syncCatalog: false, pricingAutoSync: false,
    pricingFetch: async () => { throw new Error("offline") }, maxRetries: 0, onWarn: () => {},
    providers: ["a", "b", "c"].map(id => ({ id, baseUrl: `${root}/${id}` })),
    loadBalancer: { auto: [{ model: "a:model", weight: 3, maxConcurrency: 1 }, { model: "b:model", priority: weighted ? 0 : 1 }, { model: "c:model", priority: 2 }] },
    failover: { now: () => clock },
  })
  hubs.push(hub)
  return hub
}

describe("G121 load balancing and bounded failover", () => {
  it("distributes concurrent requests 3:1 without using standbys or diagnostic rotations", async () => {
    const mik = await hub(true)
    const gateway = await createGateway({ hub: mik, port: 0 })
    try {
      const responses = await Promise.all(Array.from({ length: 40 }, async () => {
        const res = await fetch(`${gateway.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages }) })
        expect(res.status).toBe(200)
        return res.json()
      }))
      expect(responses).toHaveLength(40)
      expect(calls.filter(id => id === "a")).toHaveLength(30)
      expect(calls.filter(id => id === "b")).toHaveLength(10)
      expect(calls).not.toContain("c")
    } finally { await gateway.close() }
  })
  it.each([429, 500, 501, 503, 599])("opens after three consecutive %s failures, audits and recovers after 30s", async code => {
    status = code
    const mik = await hub()
    for (let i = 0; i < 4; i++) expect((await mik.generate({ model: "auto", messages })).provider).toBe("b")
    expect(calls.filter(id => id === "a")).toHaveLength(3)
    expect(mik.providerHealth.state("a")).toBe("OPEN")
    const rows = mik.usage.query().events
    expect(rows.filter(row => row.status === "ok").every(row => row.tags?.is_fallback === "true" && !!row.tags.failover_reason)).toBe(true)
    expect(rows.filter(row => row.status === "error").every(row => rows.some(ok => ok.status === "ok" && ok.traceId === row.traceId))).toBe(true)
    clock = 30_000; status = 200
    expect((await mik.generate({ model: "auto", messages })).provider).toBe("a")
    expect(mik.providerHealth.state("a")).toBe("CLOSED")
  })
  it("rechecks circuit health after FIFO waits so queued failures stop at three", async () => {
    status = 429
    const mik = await hub()
    const responses = await Promise.all(Array.from({ length: 12 }, () => mik.generate({ model: "auto", messages })))
    expect(responses.every(response => response.provider === "b")).toBe(true)
    expect(calls.filter(provider => provider === "a")).toHaveLength(3)
    expect(mik.providerHealth.state("a")).toBe("OPEN")
  })
  it("retries streaming before content and records the reason", async () => {
    status = 429
    const mik = await hub()
    const events = []
    for await (const event of mik.stream({ model: "auto", messages })) events.push(event)
    expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "b" }])
    expect(events.at(-1)).toMatchObject({ type: "finish", response: { provider: "b" } })
    expect(mik.usage.query().events.find(row => row.status === "ok")?.tags).toMatchObject({ is_fallback: "true", failover_reason: "RATE_LIMIT" })
  })
  it("queues capacity in FIFO order and removes cancelled waiters", async () => {
    const lb = new LoadBalancer({ auto: [{ model: "a:model", maxConcurrency: 1 }] })
    const first = await lb.acquire("a:model")
    const order: number[] = []
    const second = lb.acquire("a:model").then(release => { order.push(2); return release })
    const abort = new AbortController()
    const cancelled = lb.acquire("a:model", abort.signal)
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
    abort.abort()
    await cancellation
    const third = lb.acquire("a:model").then(release => { order.push(3); return release })
    expect(order).toEqual([])
    first()
    const releaseSecond = await second
    expect(order).toEqual([2])
    releaseSecond()
    const releaseThird = await third
    expect(order).toEqual([2, 3])
    releaseThird(); releaseThird()
    const final = await lb.acquire("a:model"); final()
  })
  it("reserves only one recovery probe and reopens on timeout", () => {
    const breaker = new CircuitBreaker({ now: () => clock })
    const error = new ModelInfraError("timeout", { code: "TIMEOUT", retryable: true })
    for (let i = 0; i < 3; i++) breaker.failure("a", error)
    expect(breaker.acquire("a")).toBe(false)
    clock = 30_000
    expect(breaker.acquire("a")).toBe(true)
    expect(breaker.acquire("a")).toBe(false)
    breaker.failure("a", error)
    expect(breaker.state("a")).toBe("OPEN")
  })
  it.each([null, { auto: [] }, { auto: [{ model: "a:model", weight: 0 }] }, { auto: [{ model: "a:model", priority: -1 }] }, { auto: [{ model: "a:model", maxConcurrency: 1.5 }] }])("rejects invalid configuration without echoing it: %j", config => {
    expect(() => readLoadBalancerConfig(config)).toThrow("Invalid load balancer configuration.")
  })
})
