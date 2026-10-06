import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createHttpServer } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ModelInfra, SqliteStorageAdapter } from "../src/index.js"
import { createServer } from "../src/server/index.js"
import { probeModelUrls, probeProvider } from "../src/server/provider-probe.js"

const BASE = "https://provider.example"
const KEY = "unusual+secret/with=punctuation"
const fetchOriginal = globalThis.fetch
const input = { baseUrl: BASE, apiKeyRef: "env:PROBE_KEY", protocol: "openai-compatible" as const }
const resolveKey = () => KEY
const list = () => new Response(JSON.stringify({ data: [{ id: "chat-model", name: "Chat model" }] }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("EVO-G120 temporary provider probe", () => {
  it.each([
    [BASE, "openai-compatible", [BASE + "/v1/models", BASE + "/models"]],
    [BASE + "/v1/", "openai", [BASE + "/v1/models"]],
    [BASE + "/v1/chat/completions", "openai-compatible", [BASE + "/v1/models"]],
    [BASE + "/chat/completions", "openai", [BASE + "/v1/models", BASE + "/models"]],
    [BASE + "/v1/models", "anthropic", [BASE + "/v1/models"]],
    [BASE + "/models/", "openai", [BASE + "/models"]],
    [BASE, "anthropic", [BASE + "/v1/models"]],
    [BASE + "/v1beta", "google", [BASE + "/v1beta/models"]],
  ] as const)("normalizes %s (%s)", (base, protocol, urls) => {
    expect(probeModelUrls(base, protocol)).toEqual(urls)
  })

  it("discovers through the adapter with credential headers and normalized save URL", async () => {
    const fetch = vi.fn(async () => list())
    vi.stubGlobal("fetch", fetch)
    const result = await probeProvider(input, resolveKey)
    expect(result).toMatchObject({ status: { providerId: "probe", ok: true, modelCount: 1 },
      models: [{ modelId: "chat-model", displayName: "Chat model" }], baseUrl: BASE + "/v1" })
    expect(result.status.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fetch).toHaveBeenCalledWith(BASE + "/v1/models", expect.objectContaining({
      headers: { accept: "application/json", authorization: `Bearer ${KEY}` }, redirect: "error",
    }))
  })

  it("uses Anthropic protocol authentication and parsing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude", display_name: "Claude" }] })))
    vi.stubGlobal("fetch", fetch)
    const result = await probeProvider({ ...input, protocol: "anthropic" }, resolveKey)
    expect(result.models).toEqual([{ modelId: "claude", displayName: "Claude" }])
    expect(fetch).toHaveBeenCalledWith(BASE + "/v1/models", expect.objectContaining({ headers: {
      accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": KEY,
    } }))
  })

  it("allows a keyless local provider without resolving a credential", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => list())
    const resolve = vi.fn(resolveKey)
    vi.stubGlobal("fetch", fetch)
    expect((await probeProvider({ baseUrl: "http://127.0.0.1:3211/v1", protocol: "openai-compatible" }, resolve)).status.ok).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ accept: "application/json" })
  })

  it("rejects plaintext credential input before calling even a permissive resolver", async () => {
    const resolve = vi.fn(resolveKey)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(probeProvider({ ...input, apiKeyRef: KEY }, resolve)).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" })
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("falls back only after a root /v1/models 404 and returns root base URL", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("absent", { status: 404 })).mockResolvedValueOnce(list())
    vi.stubGlobal("fetch", fetch)
    const result = await probeProvider(input, resolveKey)
    expect(result.status.ok).toBe(true)
    expect(result.baseUrl).toBe(BASE)
    expect(fetch.mock.calls.map(call => call[0])).toEqual([BASE + "/v1/models", BASE + "/models"])
  })

  it.each([401, 403, 429, 500])("does not mask HTTP %s by falling back, and redacts actual key", async status => {
    const fetch = vi.fn(async () => new Response(`Rejected ${KEY}`, { status }))
    vi.stubGlobal("fetch", fetch)
    const result = await probeProvider(input, resolveKey)
    expect(result.status.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.status.errorCode).toBe(status === 429 ? "RATE_LIMIT" : status < 429 ? "AUTH" : "PROVIDER")
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("redacts echoed keys in success model IDs and display names", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: `model-${KEY}`, name: KEY }] }))))
    const result = await probeProvider(input, resolveKey)
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(result.models[0]).toMatchObject({ modelId: "model-[REDACTED]", displayName: "[REDACTED]" })
  })

  it.each(["http://169.254.169.254", "http://0.0.0.0", "http://[fe80::1]", "file:///tmp/key"])("blocks SSRF %s before fetch", async baseUrl => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(probeProvider({ ...input, baseUrl }, resolveKey)).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([BASE + "?token=secret", BASE + "#fragment", "https://user:secret@provider.example"])("rejects credentials/query/hash %s", async baseUrl => {
    vi.stubGlobal("fetch", vi.fn())
    await expect(probeProvider({ ...input, baseUrl }, resolveKey)).rejects.toMatchObject({ status: 400 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects redirects without following an unsafe Location", async () => {
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.redirect).toBe("error")
      throw new TypeError("fetch failed: unexpected redirect")
    })
    vi.stubGlobal("fetch", fetch)
    expect((await probeProvider(input, resolveKey)).status.ok).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("real fetch refuses an upstream redirect before requesting its destination", async () => {
    const paths: string[] = []
    const upstream = createHttpServer((req, res) => {
      paths.push(req.url ?? "")
      res.writeHead(302, { location: "/redirected" })
      res.end()
    })
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    if (!address || typeof address === "string") throw new Error("Expected TCP test server")
    vi.stubGlobal("fetch", fetchOriginal)
    try {
      const result = await probeProvider({ ...input, baseUrl: `http://127.0.0.1:${address.port}` }, resolveKey)
      expect(result.status.ok).toBe(false)
      expect(paths).toEqual(["/v1/models"])
    } finally {
      upstream.closeAllConnections()
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
    }
  })

  it.each(["not json", "{}"])("rejects malformed model-list payload %s", async payload => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(payload)))
    expect((await probeProvider(input, resolveKey)).status).toMatchObject({ ok: false, errorCode: "PROVIDER" })
  })

  it("honors a hard five-second deadline even when a transport ignores AbortSignal", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}))
    vi.stubGlobal("fetch", fetch)
    const pending = probeProvider(input, resolveKey)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending).status).toMatchObject({ ok: false, errorCode: "TIMEOUT", latencyMs: 5000 })
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true)
  })

  it("shares the deadline across fallback and response body consumption", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => setTimeout(() => resolve(new Response("absent", { status: 404 })), 4000)))
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => new Promise<string>(() => {}) })
    vi.stubGlobal("fetch", fetch)
    const pending = probeProvider(input, resolveKey)
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).status).toMatchObject({ ok: false, errorCode: "TIMEOUT", latencyMs: 5000 })
  })

  it("resolves through the hub's injected environment and makes zero SQLite writes", async () => {
    vi.stubEnv("PROBE_KEY", "different-ambient-value")
    const adapter = await SqliteStorageAdapter.open(":memory:")
    const hub = await ModelInfra.init({ appId: "probe-test", db: ":memory:", storage: { type: "custom", name: "probe-test" }, env: { PROBE_KEY: KEY },
      storageFactory: () => adapter, cacheDir: mkdtempSync(join(tmpdir(), "mik-g120-")),
      syncCatalog: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {} })
    const server = await createServer({ hub, port: 0, heartbeatMs: 0, token: "gateway-probe-token" })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => list())
    vi.stubGlobal("fetch", fetch)
    const request = (body: unknown, token = "gateway-probe-token") => fetchOriginal(server.url + "/api/providers/probe", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    })
    try {
      const changes = adapter.prepare("SELECT total_changes() AS n").get()?.n
      const response = await request(input)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: { ok: true }, models: [{ modelId: "chat-model" }] })
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: `Bearer ${KEY}` } })
      expect(adapter.prepare("SELECT total_changes() AS n").get()?.n).toBe(changes)
      expect(hub.providers.list()).toEqual([])
      expect(hub.models.list()).toEqual([])
      expect(hub.usage.query().total).toBe(0)
      expect((await request(input, "wrong-token")).status).toBe(401)
      expect((await request({ ...input, protocol: "bad" })).status).toBe(400)
      expect((await request({ ...input, apiKeyRef: ["env:PROBE_KEY"] })).status).toBe(400)
      expect((await request({ ...input, baseUrl: "http://169.254.169.254" })).status).toBe(400)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { await server.close(); await hub.close() }
  })
})
