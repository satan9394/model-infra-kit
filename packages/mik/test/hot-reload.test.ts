import { mkdtempSync, writeFileSync } from "node:fs"
import { createServer as httpServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ModelInfra, type ModelInfraOptions } from "../src/hub.js"
import { createServer, type ServerHandle } from "../src/server/server.js"
import { HotReloadManager, prepareConfig } from "../src/server/reload.js"
import { openContext } from "../src/cli/context.js"
import { parseCliArgs } from "../src/cli/args.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const offline = { syncCatalog: false, pricingAutoSync: false, pricingFetch: (async () => { throw new Error("offline") }) as typeof fetch }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mik-g117-"))
  const configPath = join(dir, "mik.config.json")
  const hubOptions: ModelInfraOptions = { ...offline, appId: "reload-test", db: join(dir, "usage.db"), cacheDir: dir, maxRetries: 0 }
  const env: NodeJS.ProcessEnv = { KEY: "old-provider-key", ADMIN: "old-admin-key", READER: "read-token" }
  return { dir, configPath, hubOptions, env }
}
async function start(f: ReturnType<typeof fixture>, config: object, watch = false) {
  writeFileSync(f.configPath, JSON.stringify(config))
  const prepared = await prepareConfig(f)
  const hub = prepared.hub
  cleanup.push(() => hub.close())
  const handle = await createServer({ hub, tokens: prepared.tokens, port: 0, heartbeatMs: 10,
    reload: { ...f, watch, watchIntervalMs: 20 } })
  cleanup.push(() => handle.close())
  return { hub, handle }
}
const tokens = [{ tokenRef: "env:ADMIN", scopes: ["admin"] }, { tokenRef: "env:READER", scopes: ["read:usage"] }]
function request(handle: ServerHandle, path: string, token = "old-admin-key", method = "GET", body?: object) {
  return fetch(handle.url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined })
}

describe("G117 hot reload", () => {
  it("applies the latest save when watching changes during preparation", async () => {
    const f = fixture()
    writeFileSync(f.configPath, "1")
    let unblock!: () => void
    let captures = 0
    const manager = new HotReloadManager(1, async () => {
      const { readFile } = await import("node:fs/promises")
      const value = Number(await readFile(f.configPath, "utf8"))
      captures += 1
      if (captures === 1) await new Promise<void>(resolve => { unblock = resolve })
      return value
    }, () => {})
    cleanup.push(() => manager.close())
    manager.listen(f.configPath, true, 20)
    await new Promise(resolve => setTimeout(resolve, 80))
    writeFileSync(f.configPath, "22")
    await vi.waitFor(() => expect(captures).toBe(1))
    writeFileSync(f.configPath, "333")
    await new Promise(resolve => setTimeout(resolve, 80))
    unblock()
    await vi.waitFor(() => expect(manager.activeContext).toBe(333))
    expect(captures).toBe(2)
  })

  it("rejects caller claims that differ from the actual ledger, app or cache", async () => {
    const f = fixture()
    const memory = await ModelInfra.init({ ...f.hubOptions, db: ":memory:" })
    cleanup.push(() => memory.close())
    await expect(createServer({ hub: memory, port: 0, reload: f })).rejects.toThrow("durable")
    const hub = await ModelInfra.init(f.hubOptions)
    cleanup.push(() => hub.close())
    for (const change of [{ db: join(f.dir, "other.db") }, { appId: "other" }, { cacheDir: join(f.dir, "other") }]) {
      await expect(createServer({ hub, port: 0, reload: { ...f, hubOptions: { ...f.hubOptions, ...change } } })).rejects.toThrow("match")
    }
    expect(hub.usage.query().total).toBe(0)
  })

  it("coalesces preparation, atomically publishes, and waits for natural lease drain", async () => {
    let finish!: (n: number) => void
    const prepare = vi.fn(() => new Promise<number>(resolve => { finish = resolve }))
    const disposed: number[] = []
    const manager = new HotReloadManager(1, prepare, n => { disposed.push(n) })
    const lease = manager.acquire()
    const a = manager.reloadConfig()
    expect(manager.reloadConfig()).toBe(a)
    expect(manager.activeContext).toBe(1)
    finish(2)
    expect((await a).swapMicros).toBeGreaterThanOrEqual(0)
    expect(manager.activeContext).toBe(2)
    expect(lease.context).toBe(1)
    let closed = false
    const close = manager.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    lease.release()
    lease.release()
    await close
    expect(disposed.sort()).toEqual([1, 2])
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(await manager.reloadConfig()).toEqual({ reloaded: false })
  })

  it("keeps a real held SSE on its old provider while new requests use new router, credentials and admin token", async () => {
    let held!: ServerResponse
    let arrived!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const observed: string[] = []
    const upstream = httpServer((req, res) => {
      observed.push(`${req.url}|${req.headers.authorization}`)
      req.resume()
      req.on("end", () => {
        if (req.url === "/old/chat/completions") {
          held = res
          res.writeHead(200, { "content-type": "text/event-stream" })
          res.write(`data: ${JSON.stringify({ id: "old", object: "chat.completion.chunk", created: 1, model: "old", choices: [{ index: 0, delta: { content: "old-start" }, finish_reason: null }] })}\n\n`)
          arrived()
        } else {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ id: "new", object: "chat.completion", created: 1, model: "new", choices: [{ index: 0, message: { role: "assistant", content: "new-answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
        }
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() }))
    const port = (upstream.address() as { port: number }).port
    const f = fixture()
    const provider = (path: string) => ({ id: "p", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/${path}`, apiKeyRef: "env:KEY" })
    const router = (model: string) => ({ aliases: { auto: { rules: [], default_target: `p:${model}` } } })
    f.env.OTHER = "other-app-token"
    const scopedTokens = [...tokens, { tokenRef: "env:OTHER", scopes: ["write:chat"], appId: "other-app" }]
    const { handle, hub } = await start(f, { providers: [provider("old")], defaultModel: "p:old", router: router("old"), serverTokens: scopedTokens })
    const eventAbort = new AbortController()
    const eventResponse = await fetch(handle.url + "/api/events", { headers: { authorization: "Bearer read-token" }, signal: eventAbort.signal })
    const reader = eventResponse.body!.getReader()
    let liveEvents = ""
    const consume = (async () => {
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          liveEvents += new TextDecoder().decode(next.value)
        }
      } catch (error) { if (!eventAbort.signal.aborted) throw error }
    })()
    cleanup.push(async () => { eventAbort.abort(); await consume })
    const responsePromise = request(handle, "/v1/chat/completions", undefined, "POST", { model: "auto", stream: true, messages: [{ role: "user", content: "hello" }] })
    await arrival
    const response = await responsePromise
    const bodyPromise = response.text()
    f.env.KEY = "new-provider-key"
    f.env.ADMIN = "new-admin-key"
    writeFileSync(f.configPath, JSON.stringify({ providers: [provider("new")], defaultModel: "p:new", router: router("new"), serverTokens: scopedTokens }))
    expect((await request(handle, "/api/reload/", "read-token", "POST")).status).toBe(403)
    expect((await request(handle, "/api/reload", undefined, "POST")).status).toBe(200)
    expect((await request(handle, "/v1/models")).status).toBe(401)
    const fresh = await request(handle, "/v1/chat/completions", "new-admin-key", "POST", { model: "auto", messages: [{ role: "user", content: "hi" }] })
    expect(fresh.status).toBe(200)
    expect(await fresh.text()).toContain("new-answer")
    await vi.waitFor(() => expect(liveEvents).toContain('"modelActual":"new"'))
    const other = await request(handle, "/v1/chat/completions", "other-app-token", "POST", { model: "auto", messages: [{ role: "user", content: "other" }] })
    expect(other.status).toBe(200)
    await other.text()
    expect(observed).toEqual(["/old/chat/completions|Bearer old-provider-key", "/new/chat/completions|Bearer new-provider-key", "/new/chat/completions|Bearer new-provider-key"])
    expect(hub.providers.get("p")!.baseUrl).toContain("/old")
    held.end(`data: ${JSON.stringify({ id: "old", object: "chat.completion.chunk", created: 1, model: "old", choices: [{ index: 0, delta: { content: "old-end" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`)
    const body = await bodyPromise
    expect(body).toContain("old-start")
    expect(body).toContain("old-end")
    expect(body).toContain("[DONE]")
    await vi.waitFor(() => expect(liveEvents).toContain('"modelActual":"old"'))
    expect(liveEvents).not.toContain("other-app")
    eventAbort.abort()
    await consume
    await vi.waitFor(() => expect(hub.usage.query().total).toBe(2))
    await vi.waitFor(async () => {
      const connections = await request(handle, "/api/connections", "new-admin-key")
      expect((await connections.json()).active).toBe(0)
    })
  })

  it.each([
    "{malformed sk-secret-do-not-log",
    { providers: [{ id: "invalid:id", protocol: "openai" }] },
    { providers: [{ id: "p", protocol: "unknown" }] },
    { providers: [{ id: "p", protocol: "openai", apiKeyRef: "env:MISSING" }] },
    { providers: [{ id: "p", protocol: "openai", apiKeyRef: "file:missing-key-g117" }] },
    { providers: [{ id: "p", protocol: "openai", apiKeyRef: "keychain:unimplemented" }] },
    { router: { aliases: { auto: { rules: [{ condition: "eval(secret)", target: "p:m" }], default_target: "p:m" } } } },
    { router: { aliases: { auto: { rules: [], default_target: "missing:m" } } } },
    { db: "different.db" },
    { cacheDir: "different-cache" },
    { defaultModel: "missing:m" },
    { budget: { dailyMicros: 1.5 } },
    { serverTokens: [{ token: "raw-secret", scopes: ["admin"] }] },
  ])("rolls back invalid config %# without leaking config or changing active providers", async invalid => {
    const f = fixture()
    const warn = vi.fn()
    const { handle, hub } = await start(f, { serverTokens: tokens })
    hub.providers.add({ id: "retained", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:9" })
    writeFileSync(f.configPath, typeof invalid === "string" ? invalid : JSON.stringify(invalid))
    expect(await handle.reloadConfig()).toEqual({ reloaded: false })
    expect((await request(handle, "/api/providers")).status).toBe(200)
    expect(hub.providers.get("retained")).not.toBeNull()
    const manager = new HotReloadManager(1, async () => { throw new Error("sk-secret") }, () => {}, warn)
    expect(await manager.reloadConfig()).toEqual({ reloaded: false })
    expect(warn.mock.calls[0]![0]).not.toContain("secret")
    await manager.close()
  })

  it("captures file credentials and validates integer budget schema", async () => {
    const f = fixture()
    const key = join(f.dir, "key.txt")
    writeFileSync(key, "first-file-key")
    writeFileSync(f.configPath, JSON.stringify({ providers: [{ id: "p", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:9", apiKeyRef: `file:${key}` }], budget: { dailyMicros: 123, monthlyMicros: 456, currency: "USD" } }))
    const old = await prepareConfig(f)
    cleanup.push(() => old.hub.close())
    writeFileSync(key, "second-file-key")
    const next = await prepareConfig(f)
    cleanup.push(() => next.hub.close())
    expect(old.hub.providers.resolve("p").apiKey).toBe("first-file-key")
    expect(next.hub.providers.resolve("p").apiKey).toBe("second-file-key")
  })

  it("keeps request and integer-micro cost counters for the listener lifetime across reload", async () => {
    const f = fixture()
    const { handle } = await start(f, { serverTokens: tokens })
    const report = (id: string) => ({ requestId: id, providerId: "report", modelActual: "counted", usage: { input: 1, output: 1 },
      cost: { usd: 0.000123, low: 0.000123, high: 0.000123, source: "reported", basis: "reported" } })
    expect((await request(handle, "/api/usage/events", undefined, "POST", report("before"))).status).toBe(200)
    expect((await handle.reloadConfig()).reloaded).toBe(true)
    expect((await request(handle, "/api/usage/events", undefined, "POST", report("after"))).status).toBe(200)
    const response = await request(handle, "/metrics")
    const metrics = await response.text()
    expect(metrics).toContain('mik_requests_total{provider="report",model="counted",app_id="reload-test",status="ok"} 2')
    expect(metrics).toContain('mik_cost_micros_total{provider="report",model="counted",app_id="reload-test"} 246')
    f.env.ADMIN = "counted"
    expect((await handle.reloadConfig()).reloaded).toBe(true)
    expect((await request(handle, "/api/usage/events", "counted", "POST", report("rotated"))).status).toBe(200)
    const rotatedMetrics = await (await request(handle, "/metrics", "counted")).text()
    expect(rotatedMetrics).not.toContain('model="counted"')
    expect(rotatedMetrics).toMatch(/mik_cost_micros_total\{[^\n]+\} 369/)
  })

  it("retains active provider edits/default when omitted and never changes shared routing on failed preparation", async () => {
    const f = fixture()
    const { handle, hub } = await start(f, { serverTokens: tokens })
    hub.providers.add({ id: "edited", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:9" })
    hub.providers.setDefaultModel("edited:kept")
    expect((await handle.reloadConfig()).reloaded).toBe(true)
    const response = await request(handle, "/api/providers")
    expect(await response.text()).toContain("edited")
    const separate = await ModelInfra.init(f.hubOptions)
    cleanup.push(() => separate.close())
    expect(separate.providers.get("edited")).toBeNull()
  })

  it("watches saves, supports SIGHUP, and removes signal/watch callbacks on shutdown", async () => {
    const f = fixture()
    const previous = process.listenerCount("SIGHUP")
    const { handle } = await start(f, { serverTokens: tokens }, true)
    expect(process.listenerCount("SIGHUP")).toBe(previous + 1)
    f.env.ADMIN = "watch-admin"
    writeFileSync(f.configPath, JSON.stringify({ serverTokens: tokens, watch: true }))
    await vi.waitFor(async () => expect((await request(handle, "/api/providers", "watch-admin")).status).toBe(200))
    f.env.ADMIN = "signal-admin"
    process.emit("SIGHUP")
    await vi.waitFor(async () => expect((await request(handle, "/api/providers", "signal-admin")).status).toBe(200))
    await handle.close()
    expect(process.listenerCount("SIGHUP")).toBe(previous)
    expect(await handle.reloadConfig()).toEqual({ reloaded: false })
  })

  it("passes CLI resolved path, environment and declarative config to serve hub options", async () => {
    const f = fixture()
    writeFileSync(f.configPath, JSON.stringify({ appId: f.hubOptions.appId, db: f.hubOptions.db, cacheDir: f.dir, watch: true,
      providers: [{ id: "p", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:9", apiKeyRef: "env:KEY" }], defaultModel: "p:m" }))
    const context = await openContext(parseCliArgs(["serve", "--offline", "--config", f.configPath]), { cwd: f.dir, env: f.env, io: { out: () => {}, err: () => {} } })
    cleanup.push(context.close)
    expect(context.configPath).toBe(f.configPath)
    expect(context.config.watch).toBe(true)
    expect(context.hubOptions.db).toBe(f.hubOptions.db)
    expect(context.hub.providers.defaultModel()).toBe("p:m")
    expect(context.hub.providers.resolve("p").apiKey).toBe("old-provider-key")
  })

  it("refuses reload for an in-memory ledger before mutating or taking ownership of the caller hub", async () => {
    const hub = await ModelInfra.init({ ...offline, db: ":memory:" })
    cleanup.push(() => hub.close())
    hub.providers.add({ id: "retained", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:9" })
    await expect(createServer({ hub, port: 0, reload: { configPath: "unused.json", hubOptions: { db: ":memory:" } } })).rejects.toThrow("durable")
    expect(hub.providers.get("retained")).not.toBeNull()
    expect(hub.usage.query().total).toBe(0)
  })
})
