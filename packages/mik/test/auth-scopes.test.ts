import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestServer } from "@ai-sdk/test-server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ModelInfra } from "../src/index.js"
import { createServer, requireScope, type ServerHandle, type GatewayToken } from "../src/server/index.js"
import { resolveTokens, validateTokens } from "../src/server/auth.js"

const root = "https://mock-scopes.test/v1"
const completion = { id: "scope-chat", object: "chat.completion", created: 1, model: "mock",
  choices: [{ index: 0, message: { role: "assistant", content: "scoped reply" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
const mock = createTestServer({
  [`${root}/chat/completions`]: { response: { type: "json-value", body: completion } },
  [`${root}/stream/chat/completions`]: { response: { type: "stream-chunks", headers: { "content-type": "text/event-stream" }, chunks: [
    'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"content":"scoped stream"},"finish_reason":null}]}\n\n',
    'data: {"id":"s","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
    'data: [DONE]\n\n',
  ] } },
})
const tokens: GatewayToken[] = [
  { token: "reader-a", scopes: ["read:usage"], appId: "app-a" },
  { token: "chat-a", scopes: ["write:chat"], appId: "app-a" },
  { token: "chat-b", scopes: ["write:chat"], appId: "app-b" },
  { token: "report-a", scopes: ["write:usage"], appId: "app-a" },
  { token: "reader-b", scopes: ["read:usage"], appId: "app-b" },
  { token: "none", scopes: [] },
  { token: "star", scopes: ["*"] },
]
let hub: ModelInfra
let server: ServerHandle
const cacheDir = mkdtempSync(join(tmpdir(), "mik-scopes-"))
beforeAll(() => mock.server.start())
afterAll(() => mock.server.stop())
beforeEach(async () => {
  hub = await ModelInfra.init({ db: ":memory:", appId: "host", cacheDir, syncCatalog: false,
    pricingFetch: async () => { throw new Error("offline") }, maxRetries: 0,
    budget: { dailyMicros: 100 },
    providers: [{ id: "mock", protocol: "openai-compatible", baseUrl: root }, { id: "stream", protocol: "openai-compatible", baseUrl: root + "/stream" }], defaultModel: "mock:mock", onWarn: () => {} })
  server = await createServer({ hub, port: 0, token: "master", tokens })
})
afterEach(async () => { await server.close(); await hub.close() })
function request(path: string, token?: string, method = "GET", body?: unknown, appId?: string) {
  return fetch(server.url + path, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(appId !== undefined ? { "x-mik-app-id": appId } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const chat = { model: "mock:mock", messages: [{ role: "user", content: "hello" }] }
const report = { requestId: "report-1", providerId: "mock", modelActual: "mock", usage: { input: 10, output: 5 }, cost: { usd: 0.000003 } }
async function forbidden(response: Response) {
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: { message: "insufficient_scope", code: "FORBIDDEN" } })
}

describe("EVO-G103 scoped gateway", () => {
  it("standalone middleware fails closed without authentication metadata", () => {
    expect(() => requireScope("read:usage")({})).toThrow("insufficient_scope")
    expect(() => requireScope("read:usage")({ auth: { scopes: [] } })).toThrow("insufficient_scope")
    expect(() => requireScope("read:usage")({ auth: { scopes: ["admin"] } })).not.toThrow()
  })
  it("rejects missing, wrong, and malformed credentials; health stays public", async () => {
    expect((await request("/api/usage/summary")).status).toBe(401)
    expect((await request("/api/usage/summary", "wrong")).status).toBe(401)
    expect((await fetch(server.url + "/api/usage/summary", { headers: { authorization: "Basic reader-a" } })).status).toBe(401)
    expect((await request("/api/health")).status).toBe(200)
  })
  it("read token cannot manage providers or generate or report", async () => {
    await forbidden(await request("/api/providers", "reader-a", "POST", { id: "evil" }))
    await forbidden(await request("/api/providers", "reader-a"))
    await forbidden(await request("/v1/chat/completions", "reader-a", "POST", chat))
    await forbidden(await request("/api/usage/events", "reader-a", "POST", report))
    expect(hub.providers.get("evil")).toBeNull()
  })
  it("master and wildcard retain admin access", async () => {
    expect((await request("/api/providers", "master")).status).toBe(200)
    expect((await request("/api/providers", "star", "POST", { id: "new", protocol: "openai-compatible" })).status).toBe(201)
    await forbidden(await request("/api/usage/summary", "none"))
  })
  it("chat binds actual generation and concurrent writes to each token app", async () => {
    const responses = await Promise.all([request("/v1/chat/completions", "chat-a", "POST", chat), request("/v1/chat/completions", "chat-b", "POST", chat)])
    for (const response of responses) { expect(response.status).toBe(200); expect((await response.json()).choices[0].message.content).toBe("scoped reply") }
    expect(hub.usage.query({ appId: "app-a" }).total).toBe(1)
    expect(hub.usage.query({ appId: "app-b" }).total).toBe(1)
    expect(hub.usage.query().total).toBe(0)
    await forbidden(await request("/api/usage/summary", "chat-a"))
    await forbidden(await request("/api/models/mock:mock/ping", "chat-a", "POST", {}))
  })
  it("query, trace, summary, detail and budget reads stay isolated", async () => {
    expect((await request("/api/usage/events", "report-a", "POST", report)).status).toBe(200)
    const a = await (await request("/api/usage/logs", "reader-a")).json()
    const b = await (await request("/api/usage/logs", "reader-b")).json()
    expect(a.total).toBe(1); expect(a.events[0].appId).toBe("app-a"); expect(b.total).toBe(0)
    expect((await request("/api/usage/logs/report-1", "reader-b")).status).toBe(404)
    expect((await request("/api/usage/logs/report-1", "reader-a")).status).toBe(200)
    const summary = await (await request("/api/usage/summary", "reader-a")).json()
    expect(summary.summary.requests).toBe(1)
    expect(Math.round(summary.summary.costUsd * 1_000_000)).toBe(3)
    const budgetA = await (await request("/api/budget/status", "reader-a")).json()
    const budgetB = await (await request("/api/budget/status", "reader-b")).json()
    expect(budgetA.daily.spentMicros).toBe(3); expect(budgetB.daily.spentMicros).toBe(0)
    for (const path of ["/api/usage/trends", "/api/usage/by-model", "/api/usage/by-provider", "/api/usage/traces", "/api/budget/status", "/api/pricing"]) expect((await request(path, "reader-b")).status).toBe(200)
  })
  it("rejects app spoofing in headers, duplicate query selectors and report batches", async () => {
    await forbidden(await request("/v1/chat/completions", "chat-a", "POST", chat, "app-b"))
    for (const query of ["?appId=app-b", "?appId=", "?app_id=app-b", "?appId=app-a&appId=app-b"]) await forbidden(await request("/api/usage/logs" + query, "reader-a"))
    await forbidden(await request("/api/usage/events", "report-a", "POST", { ...report, appId: "app-b" }))
    await forbidden(await request("/api/usage/events", "report-a", "POST", { events: [report, { ...report, requestId: "bad", appId: "app-b" }] }))
    expect(hub.usage.query({ appId: "" }).total).toBe(0)
    expect((await request("/api/usage/logs?appId=app-a", "reader-a", "GET", undefined, "app-a")).status).toBe(200)
  })
  it("usage writer cannot chat, read or mutate pricing", async () => {
    await forbidden(await request("/v1/chat/completions", "report-a", "POST", chat))
    await forbidden(await request("/api/usage/summary", "report-a"))
    await forbidden(await request("/api/pricing/mock", "report-a", "PUT", { inputPerM: 2 }))
  })
  it("allows loopback development without tokens", async () => {
    await server.close()
    server = await createServer({ hub, port: 0, tokens: [] })
    expect((await request("/api/providers", undefined, "POST", { id: "dev", protocol: "openai-compatible" })).status).toBe(201)
  })
  it("meters streaming chat into the bound app", async () => {
    const response = await request("/v1/chat/completions", "chat-a", "POST", { ...chat, model: "stream:mock", stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("scoped stream")
    expect(hub.usage.query({ appId: "app-a" }).events[0]?.isStreaming).toBe(true)
    expect(hub.usage.query({ appId: "app-b" }).total).toBe(0)
  })
  it("SSE readers never receive another app's usage events", async () => {
    const controller = new AbortController()
    const response = await fetch(server.url + "/api/events", { headers: { authorization: "Bearer reader-a" }, signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    try {
      await request("/v1/chat/completions", "chat-b", "POST", chat)
      await request("/api/usage/events", "report-a", "POST", report)
      let output = ""
      while (!output.includes('"requestId":"report-1"')) {
        const next = await reader.read()
        if (next.done) break
        output += decoder.decode(next.value, { stream: true })
      }
      expect(output).toContain('"appId":"app-a"')
      expect(output).not.toContain('"appId":"app-b"')
    } finally { controller.abort(); await reader.cancel().catch(() => {}) }
  })
  it("loads env mappings or references without leaking invalid secrets", () => {
    expect(resolveTokens([{ tokenRef: "env:APP_TOKEN", scopes: ["read:usage"], appId: "a" }], { APP_TOKEN: "secret" })).toEqual([{ token: "secret", scopes: ["read:usage"], appId: "a" }])
    expect(resolveTokens(undefined, { MIK_SERVER_TOKENS: JSON.stringify(tokens) })).toEqual(tokens)
    for (const input of [[{ token: "sensitive-value", scopes: ["typo"] }], [{ token: "x", scopes: ["admin"], appId: "" }], [tokens[0], tokens[0]]]) expect(() => validateTokens(input)).toThrow("Invalid gateway token configuration.")
    expect(() => resolveTokens(undefined, { MIK_SERVER_TOKENS: "sensitive-invalid-json" })).toThrow("Invalid MIK_SERVER_TOKENS configuration.")
    expect(() => resolveTokens([{ tokenRef: "env:ABSENT", scopes: ["admin"] }], {})).toThrow()
  })
})
