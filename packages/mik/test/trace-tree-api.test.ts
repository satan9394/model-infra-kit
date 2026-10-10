import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/server.js"
import type { TraceTreeNode } from "../src/usage/trace-tree.js"

it("retains SDK/stream/report span chains, authoritative micros and redacted tool data", async () => {
  vi.stubEnv("G127_FIXTURE_KEY", "sk-g127-fixture")
  const seen: Record<string, unknown>[] = []
  const upstream = createHttpServer(async (req, res) => {
    seen.push(req.headers)
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    const common = { id: "g127", created: 1, model: "gpt-6-sol", usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.000007 } }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
    } else {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "tool", type: "function", function: { name: "lookup", arguments: '{"api_key":"sk-g127-secret"}' } }] }, finish_reason: "tool_calls" }] }))
    }
  })
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  const hub = await ModelInfra.init({ appId: "g127", db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-g127-")), syncCatalog: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {}, providers: [{ id: "p", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, apiKeyRef: "env:G127_FIXTURE_KEY" }] })
  const gateway = await createServer({ hub, port: 0, token: "g127-gateway-123" })
  const headers = { "content-type": "application/json", authorization: "Bearer g127-gateway-123", "x-mik-trace-id": "trace" }
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${gateway.url}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  try {
    for (const [span, parent, stream] of [["reason", "", false], ["output", "tool", true]] as const) {
      const response = await post("/v1/chat/completions", { model: "p:gpt-6-sol", messages: [{ role: "user", content: "hi" }], stream }, { "x-mik-span-id": span, ...(parent ? { "x-mik-parent-span-id": parent } : {}), "x-mik-step-index": stream ? "2" : "0", "x-mik-span-type": stream ? "generation" : "reasoning", ...(stream ? { "x-mik-tool-name": "g127-gateway-123" } : {}) })
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain("sk-g127-secret")
    }
    const report = await post("/api/usage/events", { requestId: "reported", providerId: "p", traceId: "trace", usage: { input: 1, output: 0 }, cost: { usd: 0.000003 }, toolName: "lookup api_key=sk-g127-secret", stepCostMicros: 999, stepCacheSavingsMicros: 999, args: { token: "g127-gateway-123" }, response: { api_key: "sk-g127-secret" } }, { "x-mik-span-id": "tool", "x-mik-parent-span-id": "reason", "x-mik-step-index": "1", "x-mik-span-type": "tool_call" })
    expect(await report.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [] })
    const response = await fetch(`${gateway.url}/api/usage/traces/trace/tree`, { headers })
    expect(response.status).toBe(200)
    const tree = await response.json() as TraceTreeNode
    const reason = tree.children[0]!
    expect(reason.spanId).toBe("reason")
    expect(reason.spanType).toBe("reasoning")
    expect(reason.children[0]!.spanId).toBe("tool")
    expect(reason.children[0]!.children[0]!.spanId).toBe("output")
    expect(reason.children[0]!.stepCostMicros).toBe(3)
    expect(reason.children[0]!.stepCacheSavingsMicros).toBe(0)
    const events = hub.usage.query({ traceId: "trace" }).events
    expect(tree.totalCostMicros).toBe(events.reduce((sum, event) => sum + event.costMicros!, 0))
    const stored = JSON.stringify(events)
    expect(stored).not.toContain("sk-g127-secret")
    expect(stored).not.toContain("g127-gateway-123")
    expect(reason.children[0]!.toolName).toContain("[REDACTED]")
    for (const item of seen) expect(item["x-mik-span-id"]).toBeUndefined()
    expect((await post("/v1/chat/completions", { model: "p:gpt-6-sol", messages: [{ role: "user", content: "hi" }] }, { "x-mik-step-index": "1.5" })).status).toBe(400)
    const malformed = await post("/api/usage/events", { requestId: "bad", providerId: "p", usage: { input: 0, output: 0 }, spanType: ["root"] })
    expect((await malformed.json()).rejected).toHaveLength(1)
    const empty = await fetch(`${gateway.url}/api/usage/traces/missing/tree`, { headers })
    expect((await empty.json()).totalCostMicros).toBe(0)
    expect((await fetch(`${gateway.url}/api/usage/traces/trace/tree`)).status).toBe(401)
  } finally {
    await gateway.close(); await hub.close()
    await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() })
    vi.unstubAllEnvs()
  }
})

it("queries every retained page and keeps app scopes isolated", async () => {
  const hub = await ModelInfra.init({ appId: "own", db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-g127-pages-")), syncCatalog: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {} })
  const base = { ts: 1, source: "test", providerId: "p", modelRequested: "m", modelActual: "m", status: "ok" as const, isStreaming: false, traceId: "shared", usage: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usd: 0.000001, low: 0.000001, high: 0.000001, basis: "manual" as const, source: "manual" as const } }
  for (let i = 0; i < 1005; i++) hub.usage.record({ ...base, requestId: String(i), spanId: String(i) })
  hub.usage.record({ ...base, requestId: "foreign", appId: "other" })
  const gateway = await createServer({ hub, port: 0 })
  try {
    const tree = await (await fetch(`${gateway.url}/api/usage/traces/shared/tree`)).json() as TraceTreeNode
    expect(tree.children).toHaveLength(1005)
    expect(tree.totalCostMicros).toBe(1005)
  } finally { await gateway.close(); await hub.close() }
})
