import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { exportArchive } from "../src/archive/stream-export.js"
import { verifyArchive } from "../src/archive/verify-prune.js"
import { archiveDirectory, archiveStore } from "./archive-fixture.js"

describe("streaming shard export", () => {
  it("splits pages into valid gzip with redaction, byte hashes and conserved integer ledgers", async () => {
    const store = await archiveStore(":memory:", 601)
    try {
      const before = store.usage.summary()
      const outDir = join(archiveDirectory(), "archive")
      const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir, chunkSize: 200 })
      const manifest = await verifyArchive(path)
      expect(manifest.shards.map(s => s.records)).toEqual([200, 200, 200, 1])
      expect(manifest).toMatchObject({ totalRecords: 601, totalCostMicros: "1803", totalSavingsMicros: "1202" })
      for (const shard of manifest.shards) {
        const bytes = readFileSync(join(outDir, shard.file))
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(shard.sha256)
        const text = gunzipSync(bytes).toString()
        expect(text).not.toContain("sk-test123")
        expect(text).not.toContain("private-value")
        expect(text.trim().split("\n")).toHaveLength(shard.records)
      }
      expect(store.usage.summary()).toEqual(before)
      await expect(exportArchive(store.usage, { beforeDate: "2026-02-01", outDir })).rejects.toThrow()
    } finally { store.close() }
  })
  it("handles empty ranges, real dates and invalid chunk sizes without mutation", async () => {
    const store = await archiveStore(":memory:", 0)
    try {
      const outDir = join(archiveDirectory(), "empty")
      expect((await verifyArchive(await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir }))).totalRecords).toBe(0)
      for (const chunkSize of [0, -1, 1.5, NaN, Infinity]) await expect(exportArchive(store.usage, { beforeDate: "2026-02-01", outDir, chunkSize })).rejects.toThrow()
      await expect(exportArchive(store.usage, { beforeDate: "2026-02-30", outDir })).rejects.toThrow()
    } finally { store.close() }
  })
  it("rejects oversized records before loading SQLite text and retains details", async () => {
    const store = await archiveStore(":memory:", 1)
    try {
      store.driver.prepare("UPDATE usage_events SET tags_json = ?").run(JSON.stringify({ text: "x".repeat(1024 * 1024) }))
      const outDir = join(archiveDirectory(), "oversized")
      await expect(exportArchive(store.usage, { beforeDate: "2026-02-01", outDir })).rejects.toThrow("64 KiB")
      expect(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()!.n).toBe(1)
    } finally { store.close() }
  })
  it("does not expose malformed secret-bearing tags in diagnostics", async () => {
    const store = await archiveStore(":memory:", 1)
    try {
      store.driver.prepare("UPDATE usage_events SET tags_json = ?").run('{"password":"private-secret-value",invalid}')
      await expect(exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(archiveDirectory(), "invalid") })).rejects.toThrow("Invalid archive JSON")
    } finally { store.close() }
  })
})
