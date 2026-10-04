import { afterEach, describe, expect, it } from "vitest"
import { Store } from "../src/store/database.js"
import { SqliteStorageAdapter } from "../src/store/sqlite-adapter.js"
import { migrate } from "../src/store/schema.js"
import { UsageRepository } from "../src/store/usage-repository.js"
import { UsageService } from "../src/usage/service.js"
import type { UsageEvent } from "../src/types.js"
import { ModelInfra } from "../src/index.js"
import { createServer } from "../src/server/index.js"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
async function open() { const store = await Store.open({ path: ":memory:" }); stores.push(store); return store }
function event(patch: Partial<UsageEvent> = {}): UsageEvent {
  return { requestId: crypto.randomUUID(), appId: "a", ts: Date.now(), source: "test", providerId: "p",
    modelRequested: "m", modelActual: "m", traceId: "trace", status: "ok", isStreaming: false,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: { usd: 0.000001, low: 0.000001, high: 0.000001, source: "override", basis: "manual" }, tags: {}, ...patch }
}

describe("FTS5 retained trace search", () => {
  it("exposes search over HTTP with read scope, app isolation, safe JSON and invalid-query 400", async () => {
    const hub = await ModelInfra.init({ db: ":memory:", appId: "a", cacheDir: mkdtempSync(join(tmpdir(), "mik-fts-")),
      syncCatalog: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {} })
    const server = await createServer({ hub, port: 0, tokens: [
      { token: "fts-reader", scopes: ["read:usage"], appId: "a" },
      { token: "fts-writer", scopes: ["write:usage"], appId: "a" },
    ] })
    try {
      hub.usage.record(event({ appId: "a", tags: { text: "needle sk-httpsecret123" } }))
      hub.usage.record(event({ appId: "b", tags: { text: "needle" } }))
      const response = await fetch(`${server.url}/api/usage/search?q=needle`, { headers: { authorization: "Bearer fts-reader" } })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).not.toContain("httpsecret123")
      expect(JSON.parse(text).hits).toHaveLength(1)
      expect(JSON.parse(text).hits[0].event.appId).toBe("a")
      const malformed = await fetch(`${server.url}/api/usage/search?q=${encodeURIComponent('"sk-hiddenquery123')}`, { headers: { authorization: "Bearer fts-reader" } })
      expect(malformed.status).toBe(400)
      expect(await malformed.text()).not.toContain("hiddenquery123")
      expect((await fetch(`${server.url}/api/usage/search?q=needle`)).status).toBe(401)
      expect((await fetch(`${server.url}/api/usage/search?q=needle`, { headers: { authorization: "Bearer fts-writer" } })).status).toBe(403)
    } finally { await server.close(); await hub.close() }
  })
  it("matches boolean, phrase, prefix and quoted punctuation with BM25 order and safe snippets", async () => {
    const store = await open()
    store.usage.insert(event({ requestId: "a", ts: 1, tags: { text: "timeout timeout timeout" }, errorCode: "rate_limit" }))
    store.usage.insert(event({ requestId: "b", ts: 2, tags: { text: "timeout then a long story about retry later" } }))
    const hits = store.usage.searchTraces('"rate_limit" OR timeout')
    expect(hits.map((hit) => hit.event.requestId)).toEqual(["a", "b"])
    expect(hits[0]!.score).toBeLessThan(hits[1]!.score)
    expect(hits[0]!.snippet).toContain("\u0001")
    expect(store.usage.searchTraces('timeout NOT retry').map((hit) => hit.event.requestId)).toEqual(["a"])
    expect(store.usage.searchTraces('"then a long"')).toHaveLength(1)
    expect(store.usage.searchTraces('ret*')).toHaveLength(1)
    expect(store.usage.searchTraces('"rate_limit"')).toHaveLength(1)
    expect(store.usage.searchTraces('"; DROP TABLE usage_events; --"')).toEqual([])
    expect(store.usage.query().total).toBe(2)
  })

  it("redacts every indexed field, secret-valued tags and tool metadata before persistence", async () => {
    const store = await open()
    store.usage.insert(event({ traceId: "sk-tracesecret123", modelActual: "sk-modelsecret123", providerId: "sk-providersecret123",
      errorCode: "Authorization: Basic ZXhhbXBsZTEyMw== timeout", tags: { apiKey: "plaincredential", text: "token=privatecredential retry", "sk-keysecret123": "value" } }))
    const raw = JSON.stringify(store.driver.prepare("SELECT * FROM usage_fts").all())
    for (const secret of ["tracesecret123", "modelsecret123", "providersecret123", "ZXhhbXBsZTEyMw", "plaincredential", "privatecredential", "keysecret123"]) expect(raw).not.toContain(secret)
    expect(raw).toContain("REDACTED")
    expect(store.usage.searchTraces("plaincredential")).toEqual([])
    expect(store.usage.searchTraces("timeout")).toHaveLength(1)
  })

  it("keeps concurrent writes, duplicates, rollback and retention atomically consistent", async () => {
    const store = await open()
    await Promise.all(Array.from({ length: 64 }, (_, i) => Promise.resolve().then(() => store.usage.insert(event({ requestId: String(i), ts: 1, tags: { text: "needle" } })))))
    expect(store.usage.searchTraces("needle", { limit: 100 })).toHaveLength(64)
    expect(store.usage.insert(event({ requestId: "0", tags: { text: "replacement" } }))).toBe(false)
    expect(store.usage.searchTraces("replacement")).toEqual([])
    const failRepo = new UsageRepository({ ...store.driver, prepare: (sql) => {
      if (sql.startsWith("INSERT INTO usage_fts")) throw new Error("index unavailable")
      return store.driver.prepare(sql)
    } })
    expect(() => failRepo.insert(event({ requestId: "failed" }))).toThrow("index unavailable")
    expect(store.usage.get("failed")).toBeNull()
    expect(() => store.driver.transaction(() => { store.usage.insert(event({ requestId: "rollback", tags: { text: "rollbackword" } })); throw new Error("rollback") })).toThrow()
    expect(store.usage.searchTraces("rollbackword")).toEqual([])
    store.usage.rollup(2)
    expect(store.usage.searchTraces("needle")).toEqual([])
    expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_fts").get()?.n).toBe(0)
    expect(store.usage.summary().requests).toBe(64)
  })

  it("enforces app scopes, request-local scopes, filters, pagination and scoped clear", async () => {
    const store = await open()
    for (const appId of ["a", "b"]) store.usage.insert(event({ requestId: appId, appId, tags: { text: "needle" } }))
    const service = new UsageService({ store, appId: "a", enabled: true })
    expect(service.searchTraces("needle").map((hit) => hit.event.appId)).toEqual(["a"])
    expect(service.withAppScope("b", () => service.searchTraces("needle", { appId: "a" })).map((hit) => hit.event.appId)).toEqual(["b"])
    expect(service.searchTraces("needle", { appId: "", limit: 1, offset: 1 })).toHaveLength(1)
    expect(service.searchTraces("needle", { model: "missing" })).toEqual([])
    expect(service.searchTraces("needle", { traceId: "trace", providerId: "p" })).toHaveLength(1)
    service.clear()
    expect(service.searchTraces("needle", { appId: "" }).map((hit) => hit.event.appId)).toEqual(["b"])
  })

  it("rejects malformed MATCH, unsafe limits and oversized queries without echoing secrets", async () => {
    const store = await open()
    for (const query of ['"sk-confidential', 'timeout OR', 'wrongfield:foo', '\0', 'a'.repeat(4097)]) {
      expect(() => store.usage.searchTraces(query)).toThrow(/Invalid/)
      try { store.usage.searchTraces(query) } catch (error) { expect(String(error)).not.toContain("confidential") }
    }
    for (const limit of [0, -1, 1.5, NaN, 1001]) expect(() => store.usage.searchTraces("timeout", { limit })).toThrow()
    expect(store.usage.searchTraces(" ")).toEqual([])
  })

  it("backfills legacy rows through redaction and degrades without FTS5", async () => {
    const driver = await SqliteStorageAdapter.open(":memory:")
    try {
      migrate(driver)
      driver.prepare(`INSERT INTO usage_events(request_id, app_id, ts, source, provider_id, model_requested, model_actual, tags_json)
        VALUES ('old', 'a', 1, 'test', 'p', 'm', 'm', ?)`).run(JSON.stringify({ token: "plainlegacysecret", text: "legacyneedle" }))
      const repo = new UsageRepository(driver)
      expect(repo.searchTraces("legacyneedle")).toHaveLength(1)
      expect(JSON.stringify(driver.prepare("SELECT * FROM usage_fts").all())).not.toContain("plainlegacysecret")
    } finally { driver.close() }
    const adapter = await SqliteStorageAdapter.open(":memory:")
    try {
      migrate(adapter)
      const warnings: string[] = []
      const repo = new UsageRepository({ prepare: (sql) => adapter.prepare(sql), close: () => {}, transaction: (fn) => adapter.transaction(fn),
        exec: (sql) => { if (sql.includes("VIRTUAL TABLE")) throw new Error("no such module: fts5"); adapter.exec(sql) } }, (message) => warnings.push(message))
      expect(repo.insert(event())).toBe(true)
      expect(warnings).toHaveLength(1)
      expect(() => repo.searchTraces("needle")).toThrow("unavailable")
    } finally { adapter.close() }
  })
})
