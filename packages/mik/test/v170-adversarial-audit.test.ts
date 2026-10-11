import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { normalizePromptForCache as key, safeCacheValue } from "../src/cache/normalizer.js"
import { QoSTracker } from "../src/router/qos-tracker.js"
import { exportArchive } from "../src/archive/stream-export.js"
import { verifyArchive, pruneArchived } from "../src/archive/verify-prune.js"
import { manifestChecksum, type ArchiveManifest } from "../src/archive/manifest.js"
import { archiveDirectory, archiveStore } from "./archive-fixture.js"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/server.js"
import { createMikFetch } from "../src/fetch.js"

const options = { temperature: 0, model: "p:m" }
const messages = (content: string) => [{ role: "user", content }]

describe("v1.7.0 adversarial audit", () => {
  it.each(["json", "json200", "plain", "sse", "multiline", "source-error", "oversized"])("redacts raw fetch %s client errors, including split SSE and unprefixed credentials", async kind => {
    const secret = "auditCredentialWithoutStandardPrefix"
    const streaming = ["sse", "multiline", "source-error"].includes(kind)
    const text = kind === "multiline" ? `event: error\nid: 7\n: comment\ndata: {"error":\ndata: {"message":"invalid key \\u0061${secret.slice(1)}","api_key":"another-secret"}}\n\n`
      : kind.startsWith("json") ? JSON.stringify({ error: { message: `invalid key ${secret}`, api_key: "another-secret" } })
      : kind === "oversized" ? secret.repeat(3000) : kind === "plain" ? `invalid key ${secret}` : `data: ${JSON.stringify({ error: { message: `invalid key ${secret}`, api_key: "another-secret" } })}\n\ndata: [DONE]\n\n`
    const bytes = new TextEncoder().encode(text)
    let calls = 0
    const adapter = createMikFetch({ baseUrl: () => "http://127.0.0.1/v1", resolveModel: () => ({ providerId: "p", modelId: "m", requested: "p:m" }),
      resolveProvider: () => ({ record: { id: "p", name: "p", appId: "default", enabled: true, headers: {}, meta: {}, createdAt: 0, updatedAt: 0 },
        apiKey: secret, apiKeySource: "ref", npmPackage: "@ai-sdk/openai-compatible", protocol: "openai-compatible", baseUrl: "https://fixture.invalid" }),
      onCall: () => { calls++ }, fetch: async () => new Response(kind === "source-error" ? new ReadableStream({ start(controller) {
        controller.error(new Error(`body failure ${secret}`))
      } }) : streaming ? new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      } }) : text, { status: streaming || kind === "json200" ? 200 : 401, headers: { "content-type": streaming ? "text/event-stream" : "text/plain",
        "x-provider-error": secret, "content-length": String(bytes.length), "retry-after": "2" } }) })
    const response = await adapter("http://127.0.0.1/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "p:m", messages: [] }) })
    expect(response.status).toBe(streaming || kind === "json200" ? 200 : 401)
    if (kind === "source-error") {
      let errorMessage = ""
      try { await response.text() } catch (error) { errorMessage = (error as Error).message }
      expect(errorMessage).toContain("body failure")
      expect(errorMessage).not.toContain(secret)
      return
    }
    const body = await response.text()
    expect(body).toContain(kind === "oversized" ? "64 KiB limit" : "invalid key")
    expect(body).not.toContain(secret)
    expect(body).not.toContain("another-secret")
    if (kind === "multiline") {
      const data = body.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("\n")
      expect(JSON.stringify(JSON.parse(data))).not.toContain(secret)
      for (const metadata of ["event: error", "id: 7", ": comment"]) expect(body).toContain(metadata)
    }
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    expect(JSON.stringify(headers)).not.toContain(secret)
    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("retry-after")).toBe("2")
    expect(calls).toBe(1)
  })
  it("bypasses cyclic and excessively deep message graphs without stack overflow", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    let deep: unknown = "leaf"
    for (let i = 0; i < 20_000; i++) deep = { child: deep }
    expect(key(cycle, options)).toBeNull()
    expect(key(deep, options)).toBeNull()
  })
  it("rejects oversized JSON, wide arrays and non-finite values", () => {
    expect(key(messages("[" + "0,".repeat(100_000) + "0]"), options)).toBeNull()
    expect(key(Array(100_000).fill(0), options)).toBeNull()
    for (const value of [NaN, Infinity, -Infinity]) expect(key([{ value }], options)).toBeNull()
    expect(key([undefined], options)).toBeNull()
    expect(key(Array(2), options)).toBeNull()
  })
  it("never executes message accessors during cache eligibility", () => {
    let calls = 0
    const input = { get content() { calls++; throw new Error("untrusted getter") } }
    expect(key([input], options)).toBeNull()
    expect(calls).toBe(0)
  })
  it("preserves JSON string literals that themselves look like JSON", () => {
    expect(key(messages('{"value":"{\\"a\\":1,\\"b\\":2}"}'), options))
      .not.toBe(key(messages('{"value":"{\\"b\\":2,\\"a\\":1}"}'), options))
    expect(key(messages('["雪", "😀", "é", "é"]'), options)).toMatch(/^[a-f0-9]{64}$/)
    expect(key(messages('[1,2]'), options)).not.toBe(key(messages('[2,1]'), options))
    expect(key(messages("hello"), { temperature: 1 })).toBeNull()
  })
  it("cache response eligibility fails closed for malformed and cyclic values", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(safeCacheValue(cycle)).toBe(false)
    expect(safeCacheValue({ value: 1n })).toBe(false)
    expect(safeCacheValue({ value: Infinity })).toBe(false)
    expect(safeCacheValue({ text: "api_key=private-test-value" })).toBe(false)
  })
  it.each(["cost", "savings"])("rejects a re-signed one-micro manifest %s mismatch without DB mutation", async kind => {
    const store = await archiveStore(":memory:", 2)
    try {
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "archive") })
      const before = store.usage.summary()
      const m = JSON.parse(readFileSync(path, "utf8")) as ArchiveManifest
      if (kind === "cost") m.totalCostMicros = (BigInt(m.totalCostMicros) + 1n).toString()
      else m.totalSavingsMicros = (BigInt(m.totalSavingsMicros) + 1n).toString()
      m.manifestChecksum = manifestChecksum(m)
      writeFileSync(path, JSON.stringify(m))
      await expect(pruneArchived(path, { store })).rejects.toThrow("ledger mismatch")
      expect(store.usage.summary()).toEqual(before)
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(2)
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_daily_rollups").get()!.n).toBe(0)
    } finally { store.close() }
  })
  it("rejects a single compressed byte flip and retains records", async () => {
    const store = await archiveStore(":memory:", 2)
    try {
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "archive") })
      const m = JSON.parse(readFileSync(path, "utf8")) as ArchiveManifest
      const shard = join(dirname(path), m.shards[0]!.file), bytes = readFileSync(shard)
      bytes[Math.floor(bytes.length / 2)]! ^= 1
      writeFileSync(shard, bytes)
      await expect(pruneArchived(path, { store })).rejects.toThrow()
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(2)
    } finally { store.close() }
  })
  it("bounds 60000ms spikes, >5000ms jitter and fifty timeouts at a finite score of five", () => {
    const tracker = new QoSTracker()
    tracker.register("p", "m")
    for (let i = 0; i < 32; i++) tracker.record("p", "m", i % 2 ? 60_000 : 1, true)
    expect(tracker.snapshot()[0]!.jitterMs).toBeGreaterThan(5000)
    for (let i = 0; i < 50; i++) tracker.record("p", "m", 60_000, false)
    const stats = tracker.snapshot()[0]!
    expect(stats).toMatchObject({ consecutiveFailures: 50, successRate: 0, qosScore: 5, effectiveWeight: 5 })
    for (const value of Object.values(stats)) if (typeof value === "number") expect(Number.isFinite(value)).toBe(true)
  })
  it("redacts archive export and verify errors at the public library boundary", async () => {
    const secret = "sk-v170-private-test-credential"
    const store = await archiveStore(":memory:", 1)
    try {
      const directory = archiveDirectory()
      const file = join(directory, secret)
      writeFileSync(file, "occupied")
      for (const action of [() => verifyArchive(join(directory, secret, "missing.json")),
        () => exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: file })]) {
        let message = ""
        try { await action() } catch (error) { message = (error as Error).message }
        expect(message).not.toBe("")
        expect(message).not.toContain(secret)
      }
    } finally { store.close() }
  })
  it("rejects mixed native wire-protocol aliases before rotating or dispatching", async () => {
    const hub = await ModelInfra.init({ db: ":memory:", cacheDir: archiveDirectory(), syncCatalog: false, pricingAutoSync: false,
      pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {},
      providers: [{ id: "o", protocol: "openai" }, { id: "a", protocol: "anthropic" }],
      loadBalancer: { mixed: [{ model: "o:m" }, { model: "a:m" }] } })
    const forward = vi.spyOn(hub, "fetch").mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }))
    const server = await createServer({ hub, port: 0, token: "audit-native-test-token" })
    try {
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${server.url}/v1/chat/completions`, { method: "POST",
          headers: { authorization: "Bearer audit-native-test-token", "content-type": "application/json", "x-mik-auto-protocol": "openai" },
          body: JSON.stringify({ model: "mixed", messages: messages("test") }) })
        expect(response.status).toBe(400)
      }
      expect(forward).not.toHaveBeenCalled()
    } finally { forward.mockRestore(); await server.close(); await hub.close() }
  })
  it("redacts client error and QoS/status/usage responses with injected provider failure", async () => {
    const secret = "sk-v170-private-test-credential"
    const transport = globalThis.fetch
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => String(input).startsWith("https://fixture.invalid")
      ? Promise.resolve(new Response(JSON.stringify({ error: { message: `Authorization: Bearer ${secret}`, type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } }))
      : transport(input, init))
    const hub = await ModelInfra.init({ db: ":memory:", cacheDir: archiveDirectory(), syncCatalog: false, pricingAutoSync: false,
      pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {},
      env: { AUDIT_KEY: secret }, providers: [{ id: "p", apiKeyRef: "env:AUDIT_KEY", baseUrl: "https://fixture.invalid" }],
      defaultModel: "p:m", maxRetries: 0, routing: "adaptive_qos", loadBalancer: { auto: [{ model: "p:m" }] } })
    const server = await createServer({ hub, port: 0, token: "audit-client-test-token" })
    try {
      const headers = { authorization: "Bearer audit-client-test-token", "content-type": "application/json" }
      const failure = await fetch(`${server.url}/v1/chat/completions`, { method: "POST", headers,
        body: JSON.stringify({ model: "auto", messages: messages("test") }) })
      expect(failure.status).toBeGreaterThanOrEqual(400)
      expect(await failure.text()).not.toContain(secret)
      for (const path of ["/api/providers/qos", "/api/providers", "/api/usage/summary", "/api/health"]) {
        const response = await fetch(server.url + path, { headers })
        expect(response.status).toBe(200)
        expect(await response.text()).not.toContain(secret)
      }
    } finally { spy.mockRestore(); await server.close(); await hub.close() }
  })
})
