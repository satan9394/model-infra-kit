/** Runnable isolated memory gate; retains all fixture artifacts for inspection. */
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../packages/mik/src/store/database.ts"
import { exportArchive } from "../packages/mik/src/archive/stream-export.ts"
import { verifyArchive } from "../packages/mik/src/archive/verify-prune.ts"

const directory = mkdtempSync(join(tmpdir(), "mik-g131-memory-"))
const store = await Store.open({ path: join(directory, "ledger.db") })
try {
  const insert = store.driver.prepare(`INSERT INTO usage_events
    (request_id, app_id, ts, source, provider_id, tags_json, cost_micros, cost_low_micros, cost_high_micros, cache_savings_micros)
    VALUES (?, 'a', 1, 'embedded', 'p', ?, 3, 2, 5, 2)`)
  const payload = JSON.stringify({ note: "x".repeat(1024) })
  store.driver.transaction(() => { for (let i = 0; i < 100_000; i++) insert.run(`r${i}`, payload) })
  global.gc?.()
  const base = process.memoryUsage()
  const peak = { ...base }
  function sample() {
    const current = process.memoryUsage()
    for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key])
  }
  const timer = setInterval(sample, 5)
  try {
    const path = await exportArchive(store.usage, { beforeDate: "2026-02-01", outDir: join(directory, "archive"), chunkSize: 2500 })
    const m = await verifyArchive(path)
    sample()
    assert.equal(m.totalRecords, 100_000)
    assert.equal(m.totalCostMicros, "300000")
    assert.equal(m.totalSavingsMicros, "200000")
    assert.equal(m.shards.length, 40)
    const archiveMemory = peak.heapUsed - base.heapUsed + peak.external - base.external
    console.log(JSON.stringify({ records: m.totalRecords, shards: m.shards.length, base, peak, archiveMemory, directory }))
    assert.ok(peak.heapUsed < 50 * 1024 * 1024, "heap peak must stay below 50 MiB")
    assert.ok(archiveMemory < 50 * 1024 * 1024, "archive heap/external growth must stay below 50 MiB")
  } finally { clearInterval(timer) }
} finally { store.close() }
