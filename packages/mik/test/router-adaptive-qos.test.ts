import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { LoadBalancer, readRoutingMode } from "../src/router/load-balancer.js"
import { createServer as createGateway } from "../src/server/server.js"

let time = 0
let slow = false
let failing = false
let root = ""
const hubs: ModelInfra[] = []
const calls: string[] = []
const messages = [{ role: "user" as const, content: "hello" }]
const upstream = createServer(async (req, res) => {
  const provider = req.url!.split("/")[1]!
  calls.push(provider)
  let body = ""
  for await (const chunk of req) body += chunk
  time += provider === "a" && slow ? 2500 : 100
  if (provider === "a" && failing) { res.writeHead(503); res.end('{"error":{"message":"unavailable"}}'); return }
  const stream = JSON.parse(body).stream
  const base = { id: "qos", model: "model", created: 1 }
  const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" })
  res.end(stream
    ? `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: provider }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`
    : JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: provider }, finish_reason: "stop" }], usage }))
})
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  root = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterEach(async () => { vi.restoreAllMocks(); for (const h of hubs.splice(0)) await h.close(); time = 0; slow = false; failing = false; calls.length = 0 })
afterAll(async () => { await new Promise<void>(resolve => upstream.close(() => resolve())) })
async function hub() {
  const h = await ModelInfra.init({ db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-qos-")), syncCatalog: false, pricingAutoSync: false,
    pricingFetch: async () => { throw new Error("offline") }, maxRetries: 0, onWarn: () => {}, routing: "adaptive_qos",
    providers: ["a", "b"].map(id => ({ id, baseUrl: `${root}/${id}` })), loadBalancer: { auto: [{ model: "a:model" }, { model: "b:model" }] } })
  hubs.push(h)
  vi.spyOn(performance, "now").mockImplementation(() => time)
  return h
}
describe("adaptive QoS request feedback", () => {
  it("routes away from 100→2500ms congestion and smoothly recovers via retained traffic", async () => {
    const h = await hub()
    const batch = async (count: number) => { calls.length = 0; for (let i = 0; i < count; i++) await h.generate({ model: "auto", messages }); return calls.filter(p => p === "a").length }
    expect(await batch(40)).toBe(20)
    slow = true
    await batch(100)
    expect(await batch(100)).toBeLessThan(40)
    const congested = h.providerQoS().find(s => s.providerId === "a")!
    expect(congested.ewmaRttMs).toBeGreaterThan(2400)
    slow = false
    await batch(2)
    expect(h.providerQoS().find(s => s.providerId === "a")!.effectiveWeight).toBeLessThan(85)
    await batch(240)
    expect(h.providerQoS().find(s => s.providerId === "a")!.effectiveWeight).toBe(85)
    expect(await batch(100)).toBe(50)
  })
  it("samples failures and measures the fallback independently", async () => {
    const h = await hub(); slow = true; failing = true
    expect((await h.generate({ model: "auto", messages })).provider).toBe("b")
    expect(h.providerQoS().find(s => s.providerId === "a")).toMatchObject({ ewmaRttMs: 2500, successRate: 0, consecutiveFailures: 1 })
    expect(h.providerQoS().find(s => s.providerId === "b")).toMatchObject({ ewmaRttMs: 100, successRate: 1 })
  })
  it("samples streaming completion and first output exactly once", async () => {
    const h = await hub()
    for await (const _ of h.stream({ model: "auto", messages })) { /* fully consume */ }
    expect(h.providerQoS().find(s => s.providerId === "a")).toMatchObject({ sampleCount: 1, ewmaRttMs: 100, ewmaTtftMs: 100 })
  })
  it("samples fetch and native gateway attempts through the same selected physical channel", async () => {
    const h = await hub()
    const direct = await h.fetch("http://127.0.0.1:0/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages }) })
    expect(direct.status).toBe(200)
    expect(h.providerQoS().find(s => s.providerId === "a")).toMatchObject({ sampleCount: 1, ewmaRttMs: 100 })
    const gateway = await createGateway({ hub: h, port: 0 })
    try {
      const res = await fetch(`${gateway.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-mik-auto-protocol": "openai" }, body: JSON.stringify({ model: "auto", messages }) })
      expect(res.status).toBe(200)
      expect(h.providerQoS().find(s => s.providerId === "b")).toMatchObject({ sampleCount: 1, ewmaRttMs: 100 })
      expect(calls).toEqual(["a", "b"])
    } finally { await gateway.close() }
  })
  it("ignores consumer abandonment and excludes unattempted channels", async () => {
    const h = await hub()
    for await (const e of h.stream({ model: "auto", messages })) if (e.type === "text_delta") break
    expect(h.providerQoS().every(s => s.sampleCount === 0)).toBe(true)
  })
  it("retains static distribution, priority tiers and pure diagnostic resolution", () => {
    const weighted = new LoadBalancer({ auto: [{ model: "a:m", weight: 3 }, { model: "b:m", weight: 1 }] })
    expect(Array.from({ length: 40 }, () => weighted.candidates("auto", () => true)![0]).filter(m => m === "a:m")).toHaveLength(30)
    const adaptive = new LoadBalancer({ auto: [{ model: "a:m" }, { model: "b:m", priority: 1 }] }, "adaptive_qos")
    adaptive.qos.record("a", "m", 2500, false)
    expect(adaptive.candidates("auto", () => true, false)![0]).toBe("a:m")
    expect(adaptive.candidates("auto", m => m !== "a:m")![0]).toBe("b:m")
    const priority = new LoadBalancer({ auto: [{ model: "a:m", weight: 1 }, { model: "b:m", weight: 100 }] }, "priority")
    expect(priority.candidates("auto", () => true)![0]).toBe("a:m")
    expect(() => readRoutingMode("secret-invalid")).toThrow("Invalid load balancer configuration.")
  })
})
