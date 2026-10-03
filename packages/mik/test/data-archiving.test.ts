import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Store } from "../src/store/database.js"
import { archiveCutoff, archiveUsage } from "../src/usage/archive.js"
import { UsageService } from "../src/usage/service.js"
import { runCommand } from "../src/cli/dispatch.js"
import { SqliteStorageAdapter } from "../src/store/sqlite-adapter.js"
import type { UsageEvent } from "../src/types.js"

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))
const stores: Store[] = []
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close() })
const directory = (): string => fs.mkdtempSync(join(tmpdir(), "mik-g113-"))
async function open(path = ":memory:"): Promise<Store> { const store = await Store.open({ path }); stores.push(store); return store }
function event(id: string, ts = archiveCutoff("2026-01-01"), appId = "a"): UsageEvent {
  return { requestId: id, appId, ts, source: "embedded", providerId: "compatible", modelRequested: "p:m", modelActual: "m",
    usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoning: 1 },
    cost: { usd: 0.000003, low: 0.000002, high: 0.000005, source: "manual", basis: "flat" },
    status: "ok", isStreaming: false, latencyMs: 50, traceId: "trace", sessionId: "session", tags: { feature: "chat" } }
}
function archive(store: Store, file = join(directory(), "usage.jsonl")) { return archiveUsage(store.usage, { beforeDate: "2026-02-01", targetFile: file }) }

describe("G113 durable usage maintenance", () => {
  it("exports complete details and exact integer checksum, preserving summary, trace and tags", async () => {
    const store = await open()
    for (let i = 0; i < 601; i++) store.usage.insert(event(`r${i}`, archiveCutoff("2026-01-01"), i % 2 ? "a" : "b"))
    store.usage.insert(event("retained", archiveCutoff("2026-02-01")))
    const before = store.usage.summary()
    const traces = store.usage.traces()
    const tags = store.usage.byTag()
    const batches = vi.spyOn(store.driver, "prepare")
    const result = archive(store)
    const content = fs.readFileSync(result.file, "utf8")
    const [headerLine, ...lines] = content.trimEnd().split("\n")
    const header = JSON.parse(headerLine!)
    expect(header.records).toBe(601)
    expect(header.checksum).toEqual({ cost_micros: "1803", low_micros: "1202", high_micros: "3005", input_tokens: "6611", output_tokens: "4207", cache_read_tokens: "1803", cache_write_tokens: "1202", reasoning_tokens: "601" })
    expect(createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex")).toBe(header.sha256)
    expect(JSON.parse(lines[0]!).request_id).toBe("r0")
    expect(JSON.parse(lines[0]!).cost_micros).toBe(3)
    expect(lines).toHaveLength(601)
    expect(store.usage.query().total).toBe(1)
    expect(store.usage.summary()).toEqual(before)
    expect(store.usage.byTag().map(({ tokens: _, ...row }) => row)).toEqual(tags.map(({ tokens: _, ...row }) => row))
    expect(store.usage.traces().map(({ archivedRequests: _, ...row }) => row)).toEqual(traces.map(({ archivedRequests: _, ...row }) => row))
    expect(batches.mock.calls.some(([sql]) => sql.includes("ORDER BY rowid LIMIT 256"))).toBe(true)
  })

  it("merges an existing daily dimension and repeat archives contain zero details", async () => {
    const store = await open()
    store.usage.insert(event("first"))
    archive(store)
    store.usage.insert(event("second"))
    archive(store)
    expect(store.driver.prepare("SELECT request_count, cost_microusd, cost_low_microusd, cost_high_microusd FROM usage_daily_rollups").all()).toEqual([{ request_count: 2, cost_microusd: 6, cost_low_microusd: 4, cost_high_microusd: 10 }])
    expect(archive(store).records).toBe(0)
    expect(store.usage.summary().requests).toBe(2)
  })

  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "2026-1-01", "2026-01-01T12:00:00Z"])("rejects invalid or partial-day cutoff %s", (date) => {
    expect(() => archiveCutoff(date)).toThrow()
  })

  it("accepts a real leap day and archives a whole local day exclusively", async () => {
    expect(new Date(archiveCutoff("2024-02-29")).getDate()).toBe(29)
    const store = await open()
    const cutoff = archiveCutoff("2026-02-01")
    store.usage.insert(event("last", cutoff - 1))
    store.usage.insert(event("boundary", cutoff))
    expect(archive(store).records).toBe(1)
    expect(store.usage.get("boundary")).not.toBeNull()
  })

  it("never overwrites a file and preserves details on output errors", async () => {
    const store = await open(); store.usage.insert(event("one"))
    const file = join(directory(), "existing.jsonl")
    fs.writeFileSync(file, "original")
    expect(() => archive(store, file)).toThrow()
    expect(fs.readFileSync(file, "utf8")).toBe("original")
    expect(() => archive(store, join(directory(), "missing", "usage.jsonl"))).toThrow()
    expect(store.usage.query().total).toBe(1)
  })

  it.each(["writeSync", "fsyncSync"] as const)("rolls back when %s fails, retaining the artifact", async (method) => {
    const store = await open(); store.usage.insert(event("one"))
    const file = join(directory(), "failed.jsonl")
    vi.spyOn(fs, method).mockImplementationOnce(() => { throw new Error("disk fault") })
    expect(() => archive(store, file)).toThrow("details preserved")
    expect(fs.existsSync(file)).toBe(true)
    expect(store.usage.query().total).toBe(1)
    expect(store.driver.prepare("SELECT * FROM usage_daily_rollups").all()).toHaveLength(0)
  })

  it("detects a corrupt disk reread before any details are pruned", async () => {
    const store = await open(); store.usage.insert(event("one"))
    const actual = fs.readSync
    vi.spyOn(fs, "readSync").mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      const count = actual(...args)
      if (count > 0) (args[1] as Buffer)[0] = 0
      return count
    })
    expect(() => archive(store)).toThrow("checksum mismatch")
    expect(store.usage.query().total).toBe(1)
  })

  it.each(["cost_microusd", "cost_low_microusd", "cost_high_microusd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "request_count", "success_count"])("rolls back all dimensions if %s conservation is corrupted", async (column) => {
    const store = await open(); store.usage.insert(event("one"))
    store.driver.exec(`CREATE TRIGGER corrupt AFTER INSERT ON usage_daily_rollups BEGIN UPDATE usage_daily_rollups SET ${column} = ${column} + 1; END`)
    expect(() => archive(store)).toThrow("conservation mismatch")
    expect(store.usage.query().total).toBe(1)
    for (const table of ["usage_daily_rollups", "usage_trace_rollups", "usage_tag_rollups"]) expect(store.driver.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(0)
  })

  it("rejects unsafe per-record integers instead of silently losing precision", async () => {
    const store = await open(); const row = event("huge"); row.usage.input = Number.MAX_SAFE_INTEGER + 1; store.usage.insert(row)
    expect(() => archive(store)).toThrow("details preserved")
    expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()?.n).toBe(1)
  })

  it("VACUUM really shrinks a local file after checkpointing WAL", async () => {
    const store = await open(join(directory(), "usage.db"))
    store.driver.exec("CREATE TABLE maintenance_fixture (body BLOB)")
    store.driver.transaction(() => { for (let i = 0; i < 200; i++) store.driver.prepare("INSERT INTO maintenance_fixture VALUES (zeroblob(8192))").run() })
    store.driver.exec("DELETE FROM maintenance_fixture")
    const result = store.vacuum()
    expect(result.beforeBytes).toBeGreaterThan(1_000_000)
    expect(result.afterBytes).toBeLessThan(result.beforeBytes)
    expect(result.reclaimedBytes).toBe(result.beforeBytes - result.afterBytes)
    expect(fs.statSync(store.path).size).toBe(result.afterBytes)
  })

  it("rejects in-memory and custom adapters for physical VACUUM", async () => {
    const memory = await open()
    expect(() => memory.vacuum()).toThrow("local file-backed")
    const injected = await SqliteStorageAdapter.open(":memory:")
    const custom = await Store.open({ storage: injected }); stores.push(custom)
    expect(() => custom.vacuum()).toThrow("local file-backed")
  })

  it("UsageService archive explicitly includes every app", async () => {
    const store = await open(); store.usage.insert(event("a")); store.usage.insert(event("b", archiveCutoff("2026-01-01"), "b"))
    const usage = new UsageService({ store, appId: "a", enabled: true })
    expect(usage.summary().requests).toBe(1)
    expect(usage.archive({ beforeDate: "2026-02-01", targetFile: join(directory(), "all.jsonl") }).records).toBe(2)
    expect(store.usage.summary().requests).toBe(2)
  })

  it("a real concurrent SQLite writer cannot enter the exported snapshot and resumes after commit", async () => {
    const store = await open(join(directory(), "concurrent.db")); store.usage.insert(event("old"))
    const shared = new Int32Array(new SharedArrayBuffer(16))
    const worker = new Worker(`
      const { workerData, parentPort } = require("node:worker_threads")
      const { DatabaseSync } = require("node:sqlite")
      const shared = new Int32Array(workerData.shared)
      const db = new DatabaseSync(workerData.path)
      db.exec("PRAGMA busy_timeout = 0")
      const insert = db.prepare("INSERT INTO usage_events (request_id, app_id, ts, source, provider_id) VALUES (?, 'a', ?, 'embedded', 'compatible')")
      Atomics.store(shared, 0, 1); Atomics.notify(shared, 0)
      Atomics.wait(shared, 1, 0)
      let locked = false
      try { insert.run('must-not-enter', workerData.ts) } catch (error) { locked = /locked|busy/i.test(error.message) }
      Atomics.store(shared, 2, locked ? 1 : 2); Atomics.notify(shared, 2)
      Atomics.wait(shared, 3, 0)
      db.exec("BEGIN IMMEDIATE")
      for (let i=0; i<20; i++) insert.run('after-' + i, workerData.ts)
      db.exec("COMMIT"); db.close(); parentPort.postMessage({ locked })
    `, { eval: true, workerData: { path: store.path, shared: shared.buffer, ts: archiveCutoff("2026-01-01") } })
    const completed = new Promise<{ locked: boolean }>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject) })
    try {
      expect(Atomics.wait(shared, 0, 0, 5000)).not.toBe("timed-out")
      const original = fs.fsyncSync
      vi.spyOn(fs, "fsyncSync").mockImplementationOnce((fd) => {
        Atomics.store(shared, 1, 1); Atomics.notify(shared, 1)
        expect(Atomics.wait(shared, 2, 0, 5000)).not.toBe("timed-out")
        expect(Atomics.load(shared, 2)).toBe(1)
        original(fd)
      })
      expect(archive(store).records).toBe(1)
      Atomics.store(shared, 3, 1); Atomics.notify(shared, 3)
      expect(await completed).toEqual({ locked: true })
      expect(store.usage.query().total).toBe(20)
      expect(store.usage.summary().requests).toBe(21)
    } finally { await worker.terminate() }
  })

  it.each(["en_US.UTF-8", "zh_CN.UTF-8"])("CLI validates before opening a database and runs maintenance with %s", async (locale) => {
    const cwd = directory(); const db = join(cwd, "ledger.db"); const output: string[] = []; const errors: string[] = []
    const options = { cwd, env: { LC_ALL: locale, LANG: locale }, io: { out: (text: string) => output.push(text), err: (text: string) => errors.push(text) } }
    expect(await runCommand(["db", "archive", "--db", db, "--before", "2026-02-30", "--out", "archive.jsonl"], options)).toBe(2)
    expect(fs.existsSync(db)).toBe(false)
    expect(await runCommand(["db", "archive", "--help"], options)).toBe(0)
    expect(output.join("\n")).toContain(locale.startsWith("zh") ? "所有应用" : "All apps")
    output.length = 0
    expect(await runCommand(["db", "archive", "--db", db, "--before", "2026-02-01", "--out", "archive.jsonl", "--offline"], options)).toBe(0)
    expect(output.join("\n")).toContain(locale.startsWith("zh") ? "所有应用" : "all apps")
    expect(await runCommand(["db", "vacuum", "--db", db, "--offline"], options)).toBe(0)
    expect(output.join("\n")).toContain("SQLite")
  })
})
