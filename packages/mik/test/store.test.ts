import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModelInfraError } from "../src/errors.js"
import { Store } from "../src/store/database.js"
import { nodeSqliteDriver, type SqlDriver, type SqlDriverFactory } from "../src/store/driver.js"
import { fromMicroUsd, localDateKey, startOfLocalDay, toMicroUsd } from "../src/store/money.js"
import { MIGRATIONS, migrate } from "../src/store/schema.js"
import type { UsageEvent } from "../src/types.js"

const stores: Store[] = []
const tempDirs: string[] = []

async function openStore() {
  const store = await Store.open({ path: ":memory:" })
  stores.push(store)
  return store
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-store-f15-"))
  tempDirs.push(dir)
  return dir
}

/** Make a file read-only the way each platform spells it, and return a restore hook. */
function makeReadOnly(file: string): () => void {
  if (process.platform === "win32") {
    execFileSync("attrib", ["+R", file])
    return () => execFileSync("attrib", ["-R", file])
  }
  chmodSync(file, 0o444)
  return () => chmodSync(file, 0o644)
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  const usage = overrides.usage ?? { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "test-app",
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "embedded",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    usage,
    cost: overrides.cost ?? { usd: 0.001, low: 0.001, high: 0.001, basis: "flat", source: "modelsdev" },
    latencyMs: overrides.latencyMs ?? 120,
    firstTokenMs: overrides.firstTokenMs ?? 40,
    status: overrides.status ?? "ok",
    errorCode: overrides.errorCode,
    isStreaming: overrides.isStreaming ?? false,
    sessionId: overrides.sessionId,
    tags: overrides.tags ?? {},
  }
}

describe("Store", () => {
  it("opens, migrates and reports a schema version", async () => {
    const store = await openStore()
    expect(store.schemaVersion).toBeGreaterThan(0)
  })

  it("round-trips providers", async () => {
    const store = await openStore()
    store.providers.upsert(
      {
        id: "deepseek",
        name: "DeepSeek",
        protocol: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyRef: "env:DEEPSEEK_API_KEY",
        headers: { "x-trace": "1" },
      },
      "app-a",
    )
    const record = store.providers.get("deepseek")
    expect(record?.name).toBe("DeepSeek")
    expect(record?.headers["x-trace"]).toBe("1")
    expect(record?.enabled).toBe(true)

    store.providers.setEnabled("deepseek", false)
    expect(store.providers.get("deepseek")?.enabled).toBe(false)
    expect(store.providers.remove("deepseek")).toBe(true)
    expect(store.providers.get("deepseek")).toBeNull()
  })

  it("replaces a provider's model catalogue", async () => {
    const store = await openStore()
    store.models.replaceForProvider("deepseek", [
      { providerId: "deepseek", modelId: "deepseek-chat", displayName: "DeepSeek Chat", source: "provider_api", capabilities: { text: true, image: false, toolCall: true, reasoning: false, structuredOutput: false }, contextWindow: 128000 },
      { providerId: "deepseek", modelId: "deepseek-reasoner", displayName: "DeepSeek Reasoner", source: "provider_api", capabilities: { text: true, image: false, toolCall: true, reasoning: true, structuredOutput: false } },
    ])
    expect(store.models.list("deepseek")).toHaveLength(2)
    store.models.replaceForProvider("deepseek", [
      { providerId: "deepseek", modelId: "deepseek-chat", displayName: "DeepSeek Chat", source: "provider_api", capabilities: { text: true, image: false, toolCall: true, reasoning: false, structuredOutput: false } },
    ])
    expect(store.models.list("deepseek")).toHaveLength(1)
    expect(store.models.get("deepseek", "deepseek-chat")?.ref).toBe("deepseek:deepseek-chat")
  })

  it("stores pricing overrides that outrank upstream", async () => {
    const store = await openStore()
    store.pricing.set({ modelId: "deepseek-chat", inputPerM: 0.28, outputPerM: 0.42 })
    expect(store.pricing.get("deepseek-chat")?.inputPerM).toBe(0.28)
    expect(store.pricing.list()).toHaveLength(1)
    expect(store.pricing.remove("deepseek-chat")).toBe(true)
  })

  it("inserts usage events idempotently and summarises them", async () => {
    const store = await openStore()
    const first = event({ requestId: "req-1", cost: { usd: 0.25, low: 0.25, high: 0.25, basis: "flat", source: "modelsdev" } })
    expect(store.usage.insert(first)).toBe(true)
    expect(store.usage.insert(first)).toBe(false)

    store.usage.insert(event({ requestId: "req-2", status: "error", cost: { usd: 0, low: 0, high: 0, basis: "flat", source: "missing" } }))
    const summary = store.usage.summary()
    expect(summary.requests).toBe(2)
    expect(summary.successes).toBe(1)
    expect(summary.failures).toBe(1)
    expect(summary.costUsd).toBeCloseTo(0.25, 6)
    expect(summary.tokens.input).toBe(2000)
    expect(summary.avgLatencyMs).toBeCloseTo(120, 6)
  })

  it("accumulates money as integer micro-USD rather than float dollars", async () => {
    const store = await openStore()
    for (let index = 0; index < 1000; index += 1) {
      store.usage.insert(
        event({ requestId: `tiny-${index}`, cost: { usd: 0.000001, low: 0.000001, high: 0.000001, basis: "flat", source: "modelsdev" } }),
      )
    }
    expect(store.usage.summary().costUsd).toBeCloseTo(0.001, 9)
    expect(toMicroUsd(store.usage.summary().costUsd)).toBe(1000)
  })

  it("folds old events into daily rollups without double counting", async () => {
    const store = await openStore()
    const yesterday = startOfLocalDay(Date.now()) - 3_600_000
    store.usage.insert(event({ requestId: "old-1", ts: yesterday, cost: { usd: 1.5, low: 1.5, high: 1.5, basis: "flat", source: "modelsdev" } }))
    store.usage.insert(event({ requestId: "today-1", ts: Date.now(), cost: { usd: 0.5, low: 0.5, high: 0.5, basis: "flat", source: "modelsdev" } }))

    const before = store.usage.summary()
    expect(before.requests).toBe(2)
    expect(before.costUsd).toBeCloseTo(2, 6)

    const rolled = store.usage.rollupAndPrune(Date.now(), 30)
    expect(rolled).toBe(1)
    expect(store.usage.query().events).toHaveLength(1)

    const after = store.usage.summary()
    expect(after.requests).toBe(2)
    expect(after.costUsd).toBeCloseTo(2, 6)
    expect(after.tokens.input).toBe(before.tokens.input)

    const trends = store.usage.trends()
    expect(trends).toHaveLength(2)
    expect(trends[0]!.date).toBe(localDateKey(yesterday))
    expect(fromMicroUsd(toMicroUsd(trends[0]!.costUsd))).toBeCloseTo(1.5, 6)
  })

  it("groups usage by provider and model across events and rollups", async () => {
    const store = await openStore()
    const yesterday = startOfLocalDay(Date.now()) - 3_600_000
    store.usage.insert(event({ requestId: "a", ts: yesterday, providerId: "deepseek", modelActual: "deepseek-chat", cost: { usd: 1, low: 1, high: 1, basis: "flat", source: "modelsdev" } }))
    store.usage.insert(event({ requestId: "b", ts: Date.now(), providerId: "anthropic", modelActual: "claude-sonnet", cost: { usd: 2, low: 2, high: 2, basis: "flat", source: "modelsdev" } }))
    store.usage.rollupAndPrune(Date.now(), 30)

    const byProvider = store.usage.byProvider()
    expect(byProvider.map((bucket) => bucket.key)).toEqual(["anthropic", "deepseek"])
    expect(byProvider[0]!.costUsd).toBeCloseTo(2, 6)
    expect(store.usage.byModel()).toHaveLength(2)
  })

  it("round-trips settings as JSON", async () => {
    const store = await openStore()
    store.settings.setJson("defaultModel", { ref: "deepseek:deepseek-chat" })
    expect(store.settings.getJson("defaultModel", { ref: "" }).ref).toBe("deepseek:deepseek-chat")
    expect(store.settings.get("missing")).toBeNull()
  })
})

describe("Store storage failures", () => {
  /** A driver that behaves normally except for the write statements named by `failingSql`. */
  async function partiallyFailingDriver(failingSql: RegExp, failure: Error): Promise<SqlDriverFactory> {
    return async () => {
      const real = await nodeSqliteDriver(":memory:")
      return {
        exec: (sql: string) => real.exec(sql),
        prepare: (sql: string) => {
          const statement = real.prepare(sql)
          if (!failingSql.test(sql)) return statement
          return {
            run: () => {
              throw failure
            },
            get: (...params: unknown[]) => statement.get(...params),
            all: (...params: unknown[]) => statement.all(...params),
          }
        },
        close: () => real.close(),
      }
    }
  }

  it("rejects a read-only database file with ModelInfraError code STORAGE", async () => {
    if (process.platform !== "win32" && process.getuid?.() === 0) return // root ignores file modes
    const file = join(tempDir(), "usage.db")
    const seed = await Store.open({ path: file })
    seed.usage.insert(event({ requestId: "seed-1" }))
    seed.close()

    const restore = makeReadOnly(file)
    try {
      const error = await captureError(() => Store.open({ path: file }))
      expect(error).toBeInstanceOf(ModelInfraError)
      const failure = error as ModelInfraError
      expect(failure.code).toBe("STORAGE")
      expect(failure.message).toMatch(/not writable/i)
      expect(failure.message).toContain(file)
      expect(failure.cause).toBeInstanceOf(Error)
    } finally {
      restore()
    }
  })

  it("probes for a writable connection when the file itself looks writable", async () => {
    const file = join(tempDir(), "usage.db")
    const seed = await Store.open({ path: file })
    seed.close()

    // `readOnly: true` passes the file permission check, so only a real write probe
    // notices that no row can ever be recorded.
    const readOnlyFactory: SqlDriverFactory = async (target) => {
      const { DatabaseSync } = await import("node:sqlite")
      // Same structural cast the built-in node:sqlite driver uses (store/driver.ts).
      return new DatabaseSync(target, { readOnly: true }) as unknown as SqlDriver
    }

    const error = await captureError(() => Store.open({ path: file, driver: readOnlyFactory }))
    expect(error).toBeInstanceOf(ModelInfraError)
    const failure = error as ModelInfraError
    expect(failure.code).toBe("STORAGE")
    expect(failure.message).toMatch(/not writable/i)
    expect(failure.cause).toBeDefined()
  })

  it("wraps SQLite write failures from repositories as STORAGE and keeps the cause", async () => {
    const rawFailure = Object.assign(new Error("attempt to write a readonly database"), { code: "ERR_SQLITE_ERROR" })
    const store = await Store.open({
      path: ":memory:",
      driver: await partiallyFailingDriver(/INSERT[^;]*INTO\s+(usage_events|providers)\b/i, rawFailure),
    })
    stores.push(store)

    const failures: unknown[] = []
    try {
      store.usage.insert(event({ requestId: "wrap-1" }))
    } catch (error) {
      failures.push(error)
    }
    try {
      store.providers.upsert({ id: "deepseek", name: "DeepSeek", protocol: "openai-compatible" }, "app-a")
    } catch (error) {
      failures.push(error)
    }

    expect(failures).toHaveLength(2)
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ModelInfraError)
      expect((failure as ModelInfraError).code).toBe("STORAGE")
      expect((failure as ModelInfraError).cause).toBe(rawFailure)
      expect((failure as ModelInfraError).message).toContain("attempt to write a readonly database")
    }
  })

  it("does not re-wrap a ModelInfraError raised by the driver", async () => {
    const original = new ModelInfraError("Storage is gone", { code: "STORAGE", cause: new Error("boom") })
    const store = await Store.open({
      path: ":memory:",
      driver: await partiallyFailingDriver(/INSERT[^;]*INTO\s+usage_events\b/i, original),
    })
    stores.push(store)

    let caught: unknown
    try {
      store.usage.insert(event({ requestId: "no-double-wrap" }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(original)
  })

  it("migrates the same database twice without throwing", async () => {
    const file = join(tempDir(), "usage.db")
    const first = await Store.open({ path: file })
    const version = first.schemaVersion
    expect(version).toBeGreaterThan(0)
    expect(migrate(first.driver)).toBe(version)

    const second = await Store.open({ path: file })
    expect(second.schemaVersion).toBe(version)
    expect(migrate(second.driver)).toBe(version)
    // The write probe is rolled back, so it must not survive in the schema.
    expect(second.driver.prepare("SELECT name FROM sqlite_master WHERE name = '__mik_write_probe'").get()).toBeUndefined()

    first.close()
    second.close()
  })

  it("survives a concurrent cold start that already recorded the migration version", async () => {
    const real = await nodeSqliteDriver(":memory:")
    expect(migrate(real)).toBeGreaterThan(0)

    // Simulate the race window: the row is committed, but this connection read an
    // empty `schema_migrations` just before the other process wrote it.
    const racer: SqlDriver = {
      exec: (sql: string) => real.exec(sql),
      prepare: (sql: string) => {
        const statement = real.prepare(sql)
        if (!/SELECT version FROM schema_migrations/i.test(sql)) return statement
        return {
          run: (...params: unknown[]) => statement.run(...params),
          get: (...params: unknown[]) => statement.get(...params),
          all: () => [],
        }
      },
      close: () => real.close(),
    }

    // Without `INSERT OR IGNORE` this throws a primary-key conflict.
    // EVO-G75 added migration v2, so the count is `MIGRATIONS.length`, not a
    // literal that has to be bumped by every future card.
    expect(migrate(racer)).toBe(MIGRATIONS.length)
    expect(Number(real.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n)).toBe(MIGRATIONS.length)
    real.close()
  })
})
