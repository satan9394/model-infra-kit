import { readFileSync, writeFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { gzipSync, gunzipSync } from "node:zlib"
import { describe, it, expect, vi } from "vitest"
import { exportArchive } from "../src/archive/stream-export.js"
import { verifyArchive, pruneArchived } from "../src/archive/verify-prune.js"
import { manifestChecksum, type ArchiveManifest } from "../src/archive/manifest.js"
import { archiveDirectory, archiveStore } from "./archive-fixture.js"

describe("offline verification and atomic prune", () => {
  it("verifies an archive offline in a different timezone", async () => {
    const store = await archiveStore(":memory:", 1)
    try {
      vi.stubEnv("TZ", "Pacific/Honolulu")
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "archive") })
      vi.stubEnv("TZ", "Asia/Tokyo")
      expect((await verifyArchive(path)).totalRecords).toBe(1)
    } finally { vi.unstubAllEnvs(); store.close() }
  })
  it.each(["traversal", "duplicate", "missing", "total", "fractional", "unterminated"])("rejects malformed %s archives", async kind => {
    const store = await archiveStore(":memory:", 2)
    try {
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "archive"), chunkSize: 1 })
      const m = JSON.parse(readFileSync(path, "utf8")) as ArchiveManifest
      if (kind === "traversal") m.shards[0]!.file = "../outside.gz"
      if (kind === "duplicate") m.shards[1]!.file = m.shards[0]!.file
      if (kind === "missing") m.shards.push({ ...m.shards[0]!, file: "archive-2026-02-01-part03.ndjson.gz" })
      if (kind === "total") m.totalSavingsMicros = "5"
      if (kind === "fractional" || kind === "unterminated") {
        const shardPath = join(dirname(path), m.shards[0]!.file)
        let text = gunzipSync(readFileSync(shardPath)).toString()
        text = kind === "fractional" ? text.replace('"cost_micros":3', '"cost_micros":3.5') : text.trimEnd()
        const bytes = gzipSync(text); writeFileSync(shardPath, bytes)
        m.shards[0]!.sha256 = createHash("sha256").update(bytes).digest("hex")
      }
      m.manifestChecksum = manifestChecksum(m); writeFileSync(path, JSON.stringify(m))
      await expect(pruneArchived(path, { store })).rejects.toThrow()
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(2)
    } finally { store.close() }
  })
  it.each(["bytes", "manifest", "savings", "cost", "identity"])("rejects %s corruption without deleting details", async kind => {
    const store = await archiveStore()
    try {
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "archive"), chunkSize: 10 })
      const before = store.usage.summary()
      const m = JSON.parse(readFileSync(path, "utf8")) as ArchiveManifest
      if (kind === "bytes") writeFileSync(join(dirname(path), m.shards[0]!.file), "corrupt")
      if (kind === "manifest") { m.totalCostMicros = "100"; writeFileSync(path, JSON.stringify(m)) }
      if (kind === "savings") store.driver.prepare("UPDATE usage_events SET cache_savings_micros = cache_savings_micros + 1 WHERE request_id = 'r0'").run()
      if (kind === "cost") store.driver.prepare("UPDATE usage_events SET cost_micros = cost_micros + 1 WHERE request_id = 'r0'").run()
      if (kind === "identity") store.driver.prepare("UPDATE usage_events SET request_id = 'replacement' WHERE request_id = 'r0'").run()
      const current = store.usage.summary()
      await expect(pruneArchived(path, { store })).rejects.toThrow()
      expect(store.usage.summary()).toEqual(current)
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(before.requests)
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_daily_rollups").get()!.n).toBe(0)
    } finally { store.close() }
  })
  it("rejects ledger mismatches even with recomputed file and manifest checksums", async () => {
    const store = await archiveStore()
    try {
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "archive") })
      const m = JSON.parse(readFileSync(path, "utf8")) as ArchiveManifest
      const shardPath = join(dirname(path), m.shards[0]!.file)
      const bytes = gzipSync(gunzipSync(readFileSync(shardPath)).toString().replace('"cost_micros":3', '"cost_micros":4'))
      writeFileSync(shardPath, bytes)
      m.shards[0]!.sha256 = createHash("sha256").update(bytes).digest("hex")
      m.manifestChecksum = manifestChecksum(m); writeFileSync(path, JSON.stringify(m))
      await expect(verifyArchive(path)).rejects.toThrow("ledger mismatch")
    } finally { store.close() }
  })
  it("retains summaries and newer details, rejects repeat prune and reclaims file pages", async () => {
    const db = join(archiveDirectory(), "ledger.db")
    const store = await archiveStore(db, 2000)
    try {
      store.driver.prepare("UPDATE usage_events SET ts = ? WHERE request_id = 'r0'").run(new Date(2026, 2, 1).getTime())
      const before = store.usage.summary(), tags = store.usage.byTag(), traces = store.usage.traces()
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "archive"), chunkSize: 333 })
      store.driver.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      const size = statSync(db).size
      expect(await pruneArchived(path, { store, vacuum: true })).toBe(1999)
      // G130 local-cache ratios cover retained detail; financial totals include rollups.
      expect(store.usage.summary()).toEqual({ ...before, localCacheRequests: 1 })
      expect(store.usage.byTag().map(({ tokens: _, ...row }) => row)).toEqual(tags.map(({ tokens: _, ...row }) => row))
      expect(store.usage.traces().map(({ archivedRequests: _, ...row }) => row)).toEqual(traces.map(({ archivedRequests: _, ...row }) => row))
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(1)
      expect(statSync(db).size).toBeLessThan(size)
      await expect(pruneArchived(path, { store })).rejects.toThrow("ledger mismatch")
    } finally { store.close() }
  })
  it("rolls back every rollup if the final delete fails", async () => {
    const store = await archiveStore()
    try {
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "archive") })
      store.driver.exec("CREATE TRIGGER reject_prune BEFORE DELETE ON usage_events BEGIN SELECT RAISE(ABORT, 'blocked'); END")
      await expect(pruneArchived(path, { store })).rejects.toThrow()
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(33)
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_daily_rollups").get()!.n).toBe(0)
    } finally { store.close() }
  })
})
