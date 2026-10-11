import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Transform, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import type { Store } from "../store/database.js"
import { redact } from "../util/redact.js"
import { archiveJson, archiveLine, manifestChecksum, MAX_RECORD_BYTES, micros, type ArchiveManifest } from "./manifest.js"

const decimal = (value: unknown): boolean => typeof value === "string" && /^(0|[1-9]\d{0,39})$/.test(value)
const hash = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const count = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
function calendarDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function readManifest(path: string): Promise<ArchiveManifest> {
  const handle = await open(path, "r")
  let value: unknown
  try {
    if ((await handle.stat()).size > 4 * 1024 * 1024) throw new Error("Archive manifest exceeds 4 MiB limit")
    // Bounded read prevents a concurrently growing manifest from exhausting memory.
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!result.bytesRead) break
      bytesRead += result.bytesRead
    }
    if (bytesRead === buffer.length) throw new Error("Archive manifest exceeds 4 MiB limit")
    value = archiveJson(buffer.subarray(0, bytesRead).toString("utf8"))
  } finally { await handle.close() }
  if (!value || typeof value !== "object") throw new Error("Invalid archive manifest")
  const m = value as ArchiveManifest
  // The exported absolute boundary survives moving files to a different timezone.
  if (m.version !== "1.0" || m.scope !== "all-apps" || !calendarDate(m.beforeDate) ||
      !Number.isSafeInteger(m.cutoffMs) || !Number.isFinite(new Date(m.cutoffMs).getTime()) || typeof m.exportedAt !== "string" || !Number.isFinite(Date.parse(m.exportedAt)) ||
      !count(m.totalRecords) || !decimal(m.totalCostMicros) || !decimal(m.totalSavingsMicros) ||
      !hash(m.dataChecksum) || !hash(m.manifestChecksum) || !Array.isArray(m.shards) || m.shards.length > 10_000) throw new Error("Invalid archive manifest")
  for (const [i, s] of m.shards.entries()) {
    const expected = `archive-${m.beforeDate}-part${String(i + 1).padStart(2, "0")}.ndjson.gz`
    if (!s || s.file !== expected || !count(s.records) || s.records === 0 || !hash(s.sha256) || !decimal(s.costMicros) || !decimal(s.savingsMicros)) throw new Error("Invalid archive shard metadata")
  }
  if (manifestChecksum(m) !== m.manifestChecksum) throw new Error("Archive manifest checksum mismatch")
  return m
}

/** Offline IO only: bounded decompression; no database, network or mutations. */
export async function verifyArchive(manifestPath: string): Promise<ArchiveManifest> {
  try { return await readArchive(manifestPath) }
  catch (error) { throw new Error(redact(`Archive verify failed: ${error instanceof Error ? error.message : String(error)}`)) }
}

async function readArchive(manifestPath: string): Promise<ArchiveManifest> {
  const m = await readManifest(manifestPath)
  let totalRecords = 0, totalCost = 0n, totalSavings = 0n
  const dataHash = createHash("sha256")
  for (const s of m.shards) {
    const path = join(dirname(manifestPath), s.file)
    if (!(await lstat(path)).isFile()) throw new Error("Archive shard must be a regular file")
    const fileHash = createHash("sha256")
    let pending = Buffer.alloc(0), records = 0, cost = 0n, savings = 0n
    await pipeline(createReadStream(path), new Transform({
      transform(chunk: Buffer, _encoding, callback) { fileHash.update(chunk); callback(null, chunk) },
    }), createGunzip(), new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          dataHash.update(chunk)
          const buffer = Buffer.concat([pending, chunk])
          let start = 0, end: number
          while ((end = buffer.indexOf(10, start)) >= 0) {
            if (end - start + 1 > MAX_RECORD_BYTES) throw new Error("Archive record exceeds 64 KiB limit")
            const row = archiveJson(buffer.subarray(start, end).toString("utf8")) as Record<string, unknown>
            if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.request_id !== "string" ||
                typeof row.ts !== "number" || !Number.isSafeInteger(row.ts) || row.ts >= m.cutoffMs) throw new Error("Invalid archive record")
            cost += micros(row.cost_micros); savings += micros(row.cache_savings_micros)
            records++
            if (records > s.records) throw new Error("Archive record count mismatch")
            start = end + 1
          }
          pending = Buffer.from(buffer.subarray(start))
          if (pending.length >= MAX_RECORD_BYTES) throw new Error("Archive record exceeds 64 KiB limit")
          callback()
        } catch (error) { callback(error as Error) }
      },
    }))
    if (pending.length || records !== s.records || cost.toString() !== s.costMicros || savings.toString() !== s.savingsMicros ||
        fileHash.digest("hex") !== s.sha256) throw new Error("Archive shard checksum or ledger mismatch")
    totalRecords += records; totalCost += cost; totalSavings += savings
  }
  if (totalRecords !== m.totalRecords || totalCost.toString() !== m.totalCostMicros || totalSavings.toString() !== m.totalSavingsMicros ||
      dataHash.digest("hex") !== m.dataChecksum) throw new Error("Archive total checksum or ledger mismatch")
  return m
}

export interface PruneArchiveOptions { store: Store; vacuum?: boolean }

/** Verification precedes a write-locked, synchronous ledger check + conserved rollup. */
export async function pruneArchived(manifestPath: string, options: PruneArchiveOptions): Promise<number> {
  try {
    const m = await verifyArchive(manifestPath)
    const deleted = options.store.usage.archive(m.cutoffMs, rows => {
      let records = 0, cost = 0n, savings = 0n
      const digest = createHash("sha256")
      for (const row of rows()) {
        records++; cost += micros(row.cost_micros); savings += micros(row.cache_savings_micros)
        digest.update(archiveLine(row))
      }
      if (records !== m.totalRecords || cost.toString() !== m.totalCostMicros || savings.toString() !== m.totalSavingsMicros ||
          digest.digest("hex") !== m.dataChecksum) throw new Error("Archive database ledger mismatch; pruning refused")
    }, 16)
    if (options.vacuum) options.store.vacuum()
    return deleted
  } catch (error) {
    throw new Error(redact(`Archive prune failed: ${error instanceof Error ? error.message : String(error)}`))
  }
}
