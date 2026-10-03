import { EventEmitter } from "node:events"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as nodeServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer, type ServerHandle } from "../src/server/server.js"
import { SseStream } from "../src/server/sse.js"
import { InFlightTracker } from "../src/server/context.js"

class ResponseStub extends EventEmitter {
  headersSent = false
  writableEnded = false
  destroyed = false
  accepting = true
  frames: string[] = []
  writeHead() { this.headersSent = true }
  write(frame: string) { this.frames.push(frame); return this.accepting }
  end() { this.writableEnded = true; this.emit("finish") }
}
const cacheDir = mkdtempSync(join(tmpdir(), "mik-keepalive-"))
const hubs: ModelInfra[] = []
const servers: ServerHandle[] = []
const pending: Array<{ res: ServerResponse; stream: boolean }> = []
const upstream = nodeServer(async (req, res) => {
  let raw = ""
  for await (const part of req) raw += part
  pending.push({ res, stream: !!JSON.parse(raw).stream })
})
let upstreamUrl = ""
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterEach(async () => {
  vi.useRealTimers()
  for (const server of servers.splice(0)) await server.close()
  for (const hub of hubs.splice(0)) await hub.close()
  pending.splice(0)
})
afterAll(async () => { await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() }) })
async function setup() {
  const hub = await ModelInfra.init({ appId: "host", db: ":memory:", cacheDir, syncCatalog: false, pricingAutoSync: false,
    pricingFetch: async () => { throw new Error("offline") }, maxRetries: 0, onWarn: () => {},
    providers: [{ id: "p", baseUrl: upstreamUrl, protocol: "openai-compatible" }], defaultModel: "p:model",
    router: { aliases: { auto: { rules: [], default_target: "p:model" } } },
  })
  hubs.push(hub)
  const server = await createServer({ hub, port: 0, heartbeatMs: 20, tokens: [
    { token: "read-a", scopes: ["read:usage"], appId: "a" }, { token: "chat-a", scopes: ["write:chat"], appId: "a" },
    { token: "admin-b", scopes: ["admin"], appId: "b" }, { token: "master", scopes: ["admin"] },
  ] })
  servers.push(server)
  return server
}
async function snapshot(server: ServerHandle, token = "read-a") {
  const response = await fetch(server.url + "/api/connections", { headers: { authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  return response.json() as Promise<ReturnType<InFlightTracker["snapshot"]>>
}
function chat(server: ServerHandle, stream: boolean, signal?: AbortSignal, path = "/v1/chat/completions") {
  return fetch(server.url + path, { method: "POST", signal,
    headers: { authorization: "Bearer chat-a", "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "private prompt sk-secret-123456" }], stream }) })
}
function complete(index: number, error = false) {
  const entry = pending[index]!
  if (error) { entry.res.writeHead(503); entry.res.end("unavailable"); return }
  const base = { id: "test", created: 1, model: "model" }
  const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  if (entry.stream) {
    entry.res.writeHead(200, { "content-type": "text/event-stream" })
    entry.res.end(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`)
  } else {
    entry.res.writeHead(200, { "content-type": "application/json" })
    entry.res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage }))
  }
}

describe("G114 SSE keepalive and connection diagnostics", () => {
  it.each([
    ["/v1/chat/completions/", "/api/events/"],
    ["/v1/%63hat/completions", "/api/%65vents"],
  ])("tracks normalized chat %s and event %s routes", async (chatPath, eventsPath) => {
    const server = await setup()
    const result = chat(server, false, undefined, chatPath)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const events = await fetch(server.url + eventsPath, { headers: { authorization: "Bearer read-a" } })
    expect(events.status).toBe(200)
    expect(await snapshot(server)).toMatchObject({ requests: 1, events: 1, active: 2 })
    complete(0)
    expect((await result).status).toBe(200)
    await events.body!.cancel()
    await vi.waitFor(async () => expect((await snapshot(server)).active).toBe(0))
  })
  it("emits three exact comments over 45 seconds of silence, ignores comments in business parsing, and starts once", async () => {
    vi.useFakeTimers()
    const res = new ResponseStub()
    const stream = new SseStream(res as unknown as ServerResponse, 15_000)
    stream.open(); stream.startHeartbeat(); stream.startHeartbeat()
    await vi.advanceTimersByTimeAsync(45_000)
    expect(res.frames.filter(frame => frame === ": ping\n\n")).toHaveLength(3)
    await stream.raw('data: {"answer":"ok"}\n\n')
    expect(res.frames.join("").split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))).toEqual([{ answer: "ok" }])
    stream.close(); stream.close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(["close", "error", "finish"])("cleans heartbeat and backpressure listeners on %s", async event => {
    vi.useFakeTimers()
    const res = new ResponseStub()
    const stream = new SseStream(res as unknown as ServerResponse, 15_000)
    stream.startHeartbeat()
    res.accepting = false
    const write = stream.raw("data: slow\n\n")
    await vi.advanceTimersByTimeAsync(45_000)
    expect(res.frames).toEqual(["data: slow\n\n"])
    const closed = vi.fn(); stream.onClose(closed)
    res.emit(event, event === "error" ? new Error("disconnect") : undefined)
    await write
    expect(closed).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(res.listenerCount("drain")).toBe(0)
  })
  it("bounds event-bus writes for a slow reader", async () => {
    const res = new ResponseStub(); res.accepting = false
    const stream = new SseStream(res as unknown as ServerResponse, 15_000)
    const first = stream.send("usage", {})
    await stream.send("usage", {})
    await first
    expect(stream.isClosed).toBe(true)
    expect(res.frames).toHaveLength(1)
  })
  it("filters app ownership before redacting labels and cleanup is idempotent", () => {
    const tracker = new InFlightTracker(["opaque-token"])
    const a = tracker.start({ kind: "chat", model: "opaque-token", ip: "127.0.0.1", appId: "a" })
    const b = tracker.start({ kind: "events", model: "sk-secret-123456", ip: "127.0.0.1", appId: "b" })
    expect(tracker.snapshot("a").connections[0]!.model).toBe("[REDACTED]")
    expect(tracker.snapshot("a").active).toBe(1)
    a.updateModel("p:physical"); expect(tracker.snapshot("a").connections[0]!.model).toBe("p:physical")
    a.close(); a.close(); b.close(); expect(tracker.snapshot("a").active).toBe(0)
  })
  it("tracks concurrent nonstream thinking and streaming, physical aliases, scoped diagnostics and normal/error completion", async () => {
    const server = await setup()
    const nonstream = chat(server, false)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const streaming = chat(server, true)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    const state = await snapshot(server)
    expect(state.requests).toBe(2)
    expect(state.connections.every(entry => entry.model === "p:model")).toBe(true)
    expect(JSON.stringify(state)).not.toContain("private prompt")
    expect((await snapshot(server, "admin-b")).active).toBe(0)
    expect((await snapshot(server, "master")).active).toBe(0)
    expect((await fetch(server.url + "/api/connections")).status).toBe(401)
    expect((await fetch(server.url + "/api/connections", { headers: { authorization: "Bearer chat-a" } })).status).toBe(403)
    expect((await fetch(server.url + "/api/connections?appId=b", { headers: { authorization: "Bearer read-a" } })).status).toBe(403)
    complete(0)
    expect((await nonstream).status).toBe(200)
    const response = await streaming
    complete(1, true)
    const text = await response.text()
    expect(text).toContain(": ping\n\n")
    expect(text).toContain("[DONE]")
    await vi.waitFor(async () => expect((await snapshot(server)).active).toBe(0))
    expect(server.sseClients).toBe(0)
  })
  it("keeps delayed stream alive and releases aborted client and event connections on shutdown", async () => {
    const server = await setup()
    const abort = new AbortController()
    const response = await chat(server, true, abort.signal)
    const reader = response.body!.getReader()
    let text = ""
    while (!text.includes(": ping\n\n")) text += new TextDecoder().decode((await reader.read()).value)
    expect((await snapshot(server)).requests).toBe(1)
    abort.abort(); await reader.cancel().catch(() => {})
    await vi.waitFor(async () => expect((await snapshot(server)).requests).toBe(0))
    const events = await fetch(server.url + "/api/events", { headers: { authorization: "Bearer read-a" } })
    expect((await snapshot(server)).events).toBe(1)
    await server.close()
    expect(server.sseClients).toBe(0)
    await events.body!.cancel().catch(() => {})
  })
  it("finishes normal delayed streaming and ignores ping comments in JSON frames", async () => {
    const server = await setup()
    const response = await chat(server, true)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    complete(0)
    const text = await response.text()
    const frames = text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)))
    expect(frames.some(frame => frame.choices?.[0]?.delta?.content === "hello")).toBe(true)
    expect((await snapshot(server)).active).toBe(0)
    expect(server.sseClients).toBe(0)
  })
  it("releases nonstream failures and clients disconnected before headers", async () => {
    const server = await setup()
    const failed = chat(server, false)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    complete(0, true)
    expect((await failed).status).toBe(502)
    expect((await snapshot(server)).requests).toBe(0)
    const abort = new AbortController()
    const aborted = chat(server, false, abort.signal).catch(() => undefined)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect((await snapshot(server)).requests).toBe(1)
    abort.abort(); await aborted
    await vi.waitFor(async () => expect((await snapshot(server)).requests).toBe(0))
    expect(server.sseClients).toBe(0)
  })
})
