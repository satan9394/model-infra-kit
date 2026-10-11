import { createHash } from "node:crypto"
import { open, mkdir } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { join, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"
import type { UsageRepository } from "../store/usage-repository.js"
import { archiveCutoff } from "../usage/archive.js"
import { archiveLine, manifestChecksum, micros, type ArchiveManifest } from "./manifest.js"

export interface StreamArchiveOptions { beforeDate: string; outDir: string; chunkSize?: number }

/** Export only. A concurrent ledger change is detected by the later prune digest. */
export async function exportArchive(repository: UsageRepository, options: StreamArchiveOptions): Promise<string> {
  const cutoffMs = archiveCutoff(options.beforeDate)
  const chunkSize = options.chunkSize ?? 50_000
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError("Invalid archive chunk size")
  if (!options.outDir.trim()) throw new TypeError("Archive output directory is required")
  const directory = resolve(options.outDir)
  // Reserve a new directory: never overwrite shards or a previous authoritative manifest.
  await mkdir(directory, { mode: 0o700 })
  const rows = repository.archiveRows(cutoffMs, repository.archiveMaxRowid(), 16)
  const dataHash = createHash("sha256")
  const manifest: ArchiveManifest = { version: "1.0", exportedAt: new Date().toISOString(),
    beforeDate: options.beforeDate, cutoffMs, scope: "all-apps", totalRecords: 0,
    totalCostMicros: "0", totalSavingsMicros: "0", dataChecksum: "", shards: [], manifestChecksum: "" }
  let totalCost = 0n, totalSavings = 0n
  let next = rows.next()
  try {
    while (!next.done) {
      if (manifest.shards.length >= 10_000) throw new RangeError("Archive exceeds 10000 shard limit; increase chunk size")
      const file = `archive-${options.beforeDate}-part${String(manifest.shards.length + 1).padStart(2, "0")}.ndjson.gz`
      let records = 0, cost = 0n, savings = 0n
      const hash = createHash("sha256")
      async function* lines(): AsyncGenerator<string> {
        while (!next.done && records < chunkSize) {
          const row = next.value
          cost += micros(row.cost_micros)
          savings += micros(row.cache_savings_micros)
          const text = archiveLine(row)
          dataHash.update(text)
          records++
          yield text
          next = rows.next()
        }
      }
      await pipeline(Readable.from(lines()), createGzip(), new Transform({
        transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk) },
      }), createWriteStream(join(directory, file), { flags: "wx", mode: 0o600 }))
      const handle = await open(join(directory, file), "r+")
      try {
        await handle.sync()
      } finally { await handle.close() }
      manifest.shards.push({ file, records, sha256: hash.digest("hex"), costMicros: cost.toString(), savingsMicros: savings.toString() })
      manifest.totalRecords += records
      totalCost += cost; totalSavings += savings
    }
    manifest.totalCostMicros = totalCost.toString()
    manifest.totalSavingsMicros = totalSavings.toString()
    manifest.dataChecksum = dataHash.digest("hex")
    manifest.manifestChecksum = manifestChecksum(manifest)
    const content = JSON.stringify(manifest, null, 2) + "\n"
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new RangeError("Archive manifest exceeds 4 MiB limit; increase chunk size")
    const path = join(directory, "manifest.json")
    const handle = await open(path, "wx", 0o600)
    try { await handle.writeFile(content); await handle.sync() }
    finally { await handle.close() }
    return path
  } finally { rows.return(undefined) }
}
