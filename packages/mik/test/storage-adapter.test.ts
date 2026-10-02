import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import { ModelInfra, SqliteStorageAdapter, type StorageAdapter } from "../src/index.js"
import { Store } from "../src/store/database.js"
import { readStorageConfig } from "../src/store/adapter.js"
import { nodeSqliteDriver } from "../src/store/driver.js"
import { parseCliArgs } from "../src/cli/args.js"
import { loadConfig, openContext } from "../src/cli/context.js"
import type { UsageEvent } from "../src/types.js"

const stores: Store[] = []
const hubs: ModelInfra[] = []
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close()
  for (const store of stores.splice(0)) store.close()
})
async function open(options: Parameters<typeof Store.open>[0] = { storage: { type: "sqlite", path: ":memory:" } }) {
  const store = await Store.open(options)
  stores.push(store)
  return store
}
function event(requestId: string): UsageEvent {
  return {
    requestId, appId: "shared", ts: Date.now(), source: "embedded", providerId: "compatible", modelRequested: "compatible:model", modelActual: "model",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: { usd: 0.000003, low: 0.000003, high: 0.000003, basis: "flat", source: "manual" },
    latencyMs: 1, status: "ok", isStreaming: false, tags: {},
  }
}

describe("G108 synchronous storage adapter contract", () => {
  it("supports default SQLite configuration and legacy driver factories", async () => {
    const configured = await open()
    const legacy = await open({ path: ":memory:", driver: nodeSqliteDriver })
    expect(configured.schemaVersion).toBe(legacy.schemaVersion)
    expect(configured.driver.prepare<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get()?.version).toBe(configured.schemaVersion)
    legacy.driver.transaction(() => legacy.settings.set("legacy", "yes"))
    expect(legacy.settings.get("legacy")).toBe("yes")
  })

  it("rolls back atomically and remains usable after failure", async () => {
    const store = await open()
    expect(() => store.driver.transaction(() => {
      store.settings.set("partial", "must disappear")
      store.usage.insert(event("partial"))
      throw new Error("fault injection")
    })).toThrow("fault injection")
    expect(store.settings.get("partial")).toBeNull()
    expect(store.usage.get("partial")).toBeNull()
    expect(store.driver.transaction(() => store.settings.set("committed", "yes"))).toBeUndefined()
    expect(store.settings.get("committed")).toBe("yes")
  })

  it("nested rollback preserves the outer transaction and outer rollback undoes nested commit", async () => {
    const store = await open()
    store.driver.transaction(() => {
      store.settings.set("outer", "yes")
      expect(() => store.driver.transaction(() => {
        store.settings.set("inner", "no")
        throw new Error("nested")
      })).toThrow("nested")
    })
    expect(store.settings.get("outer")).toBe("yes")
    expect(store.settings.get("inner")).toBeNull()
    expect(() => store.driver.transaction(() => {
      store.driver.transaction(() => store.settings.set("inner", "no"))
      throw new Error("outer")
    })).toThrow("outer")
    expect(store.settings.get("inner")).toBeNull()
  })

  it("rejects async callbacks before invocation", async () => {
    const store = await open()
    let invoked = false
    const callback = async () => { invoked = true; await Promise.resolve(); store.settings.set("late", "bad") }
    // @ts-expect-error asynchronous callbacks are prohibited by the public contract
    expect(() => store.driver.transaction(callback)).toThrow("synchronous callback")
    await Promise.resolve()
    expect(invoked).toBe(false)
    expect(store.settings.get("late")).toBeNull()
  })

  it("shares provider, usage and settings state across two independent connections without rounding loss", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "mik-g108-shared-")), "shared.db")
    const first = await open({ storage: { type: "sqlite", path } })
    const second = await open({ storage: { type: "sqlite", path } })
    first.providers.upsert({ id: "compatible", name: "Compatible", protocol: "openai-compatible", apiKeyRef: "env:SHARED_KEY" }, "shared")
    expect(second.providers.get("compatible")?.apiKeyRef).toBe("env:SHARED_KEY")
    second.settings.set("shared", "visible")
    expect(first.settings.get("shared")).toBe("visible")
    await Promise.all(Array.from({ length: 200 }, (_, index) => Promise.resolve().then(() => {
      const store = index % 2 ? first : second
      store.driver.transaction(() => store.usage.insert(event(`shared-${index}`)))
    })))
    expect(first.usage.summary({ appId: "shared" })).toMatchObject({ requests: 200, costUsd: 0.0006, costLowUsd: 0.0006, costHighUsd: 0.0006 })
    expect(second.usage.summary({ appId: "shared" }).requests).toBe(200)
    expect(first.usage.insert(event("shared-1"))).toBe(false)
  })

  it("serializes actual concurrent writers on a shared SQLite file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "mik-g108-workers-")), "shared.db")
    const store = await open({ storage: { type: "sqlite", path } })
    store.driver.exec("CREATE TABLE concurrent_micros (id INTEGER PRIMARY KEY, micros INTEGER NOT NULL)")
    store.driver.prepare("INSERT INTO concurrent_micros VALUES (?, ?)").run(1, 0)
    const source = `const { workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData);
      db.exec('PRAGMA busy_timeout = 5000');
      for (let i = 0; i < 200; i++) {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('UPDATE concurrent_micros SET micros = micros + 3 WHERE id = 1').run();
        db.exec('COMMIT');
      }
      db.close();`
    await Promise.all([0, 1].map(() => new Promise<void>((resolve, reject) => {
      const worker = new Worker(source, { eval: true, workerData: path })
      worker.on("error", reject)
      worker.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}`)))
    })))
    expect(store.driver.prepare("SELECT micros FROM concurrent_micros WHERE id = 1").get()?.micros).toBe(1200)
  })

  it("injects an adapter without local file checks or SQLite PRAGMA probes", async () => {
    const raw = await SqliteStorageAdapter.open(":memory:")
    const calls: string[] = []
    const adapter: StorageAdapter = {
      exec: (sql) => { calls.push(sql); raw.exec(sql) },
      prepare: (sql) => { calls.push(sql); return raw.prepare(sql) },
      transaction: (fn) => raw.transaction(fn),
      close: () => raw.close(),
    }
    const store = await open({ storage: adapter, path: "this-path-must-not-be-used" })
    store.settings.set("injected", "yes")
    expect(store.settings.get("injected")).toBe("yes")
    expect(calls.some((sql) => /PRAGMA (quick_check|journal_mode|busy_timeout|foreign_keys)|__mik_write_probe/.test(sql))).toBe(false)
  })

  it("ModelInfra.init uses custom configuration and asynchronous adapter factories", async () => {
    let factoryCalls = 0
    const config = { type: "custom", name: "host-connection", url: "libsql://example.invalid", authTokenRef: "env:DB_TOKEN" } as const
    const hub = await ModelInfra.init({
      storage: config,
      storageFactory: async (received) => { expect(received).toEqual(config); factoryCalls += 1; return SqliteStorageAdapter.open(":memory:") },
      pricingFetch: async () => { throw new Error("offline") }, syncCatalog: false, pricingAutoSync: false, onWarn: () => {},
    })
    hubs.push(hub)
    expect(factoryCalls).toBe(1)
    expect(hub.usage.summary().requests).toBe(0)
  })

  it("reads sqlite storage from mik.config.json and preserves explicit --db precedence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mik-g108-config-"))
    const path = join(cwd, "configured.db")
    writeFileSync(join(cwd, "mik.config.json"), JSON.stringify({ storage: { type: "sqlite", path } }))
    const options = { cwd, env: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }, io: { out: () => {}, err: () => {} } }
    const context = await openContext(parseCliArgs(["usage", "summary", "--offline"]), options)
    hubs.push(context.hub)
    expect(context.dbPath).toBe(path)
    expect(context.dbDefaulted).toBe(false)
    const explicit = await openContext(parseCliArgs(["usage", "summary", "--offline", "--db", ":memory:"]), options)
    hubs.push(explicit.hub)
    expect(explicit.dbPath).toBe(":memory:")
  })

  it("rejects inline credentials and missing custom factories without silent SQLite fallback", async () => {
    for (const config of [
      { type: "libsql", url: "libsql://example.invalid", authToken: "do-not-echo-this" },
      { type: "custom", name: "remote", url: "https://user:do-not-echo-this@example.invalid" },
      { type: "custom", name: "remote", authTokenRef: "inline-do-not-echo-this" },
    ]) {
      expect(() => readStorageConfig(config)).toThrow("Invalid storage configuration")
      try { readStorageConfig(config) } catch (error) { expect(String(error)).not.toContain("do-not-echo-this") }
    }
    for (const invalid of [null, 3, "sqlite"]) {
      // @ts-expect-error exercise malformed JavaScript configuration at the runtime boundary
      await expect(Store.open({ storage: invalid })).rejects.toThrow("Invalid storage configuration")
    }
    await expect(Store.open({ storage: { type: "custom", name: "remote" } })).rejects.toThrow("requires a storageFactory")
    const cwd = mkdtempSync(join(tmpdir(), "mik-g108-invalid-config-"))
    const path = join(cwd, "mik.config.json")
    writeFileSync(path, JSON.stringify({ storage: { type: "sqlite", path: ":memory:", authToken: "do-not-echo-this" } }))
    expect(() => loadConfig(path, { out: () => {}, err: () => {} })).toThrow("Invalid storage configuration")
  })
})
