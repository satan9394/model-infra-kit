import { createHash } from "node:crypto"
import { closeSync, fsyncSync, openSync, readSync, writeSync } from "node:fs"
import { resolve } from "node:path"
import type { UsageRepository } from "../store/usage-repository.js"
import { redact } from "../util/redact.js"

export interface ArchiveOptions { beforeDate: string; targetFile: string }
export interface ArchiveResult { file: string; records: number; costMicros: string; sha256: string }

/** A real local calendar day, matching SQLite daily rollup boundaries. */
export function archiveCutoff(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError("Archive date must be YYYY-MM-DD")
  const [year, month, day] = value.split("-").map(Number) as [number, number, number]
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new TypeError("Invalid archive calendar date")
  return date.getTime()
}

const integerFields = ["cost_micros", "low_micros", "high_micros", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const

function integer(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RangeError("Unsafe archive integer value")
  return BigInt(value)
}

function line(row: Record<string, unknown>): string {
  const safe = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]))
  return `${JSON.stringify(safe)}\n`
}

/** IO is explicit; cutoff validation and integer checksum calculation are pure. */
export function archiveUsage(repository: UsageRepository, options: ArchiveOptions): ArchiveResult {
  const cutoff = archiveCutoff(options.beforeDate)
  if (!options.targetFile.trim() || !options.targetFile.endsWith(".jsonl") || options.targetFile.includes("\0")) throw new TypeError("Archive output must be a new .jsonl file")
  const file = resolve(options.targetFile)
  // wx prevents overwrites and validates output permissions before SQL mutations.
  const fd = openSync(file, "wx+", 0o600)
  try {
    let result: ArchiveResult | undefined
    repository.archive(cutoff, (rows) => {
      let records = 0
      const totals = integerFields.map(() => 0n)
      const bodyHash = createHash("sha256")
      for (const row of rows()) {
        records += 1
        integerFields.forEach((field, i) => { totals[i] = totals[i]! + integer(row[field]) })
        bodyHash.update(line(row))
      }
      const sha256 = bodyHash.digest("hex")
      const header = `${JSON.stringify({ type: "mik-usage-archive", version: 1, before_date: options.beforeDate, cutoff_ms: cutoff,
        scope: "all-apps", records, checksum: Object.fromEntries(integerFields.map((field, i) => [field, totals[i]!.toString()])), sha256 })}\n`
      const writtenHash = createHash("sha256")
      const write = (text: string): void => {
        const buffer = Buffer.from(text)
        let offset = 0
        while (offset < buffer.length) {
          const size = writeSync(fd, buffer, offset, buffer.length - offset)
          if (size === 0) throw new Error("Archive write made no progress")
          offset += size
        }
        writtenHash.update(buffer)
      }
      write(header)
      const exportedHash = createHash("sha256")
      let exportedCount = 0
      for (const row of rows()) {
        const text = line(row)
        write(text)
        exportedHash.update(text)
        exportedCount += 1
      }
      if (exportedCount !== records || exportedHash.digest("hex") !== sha256) throw new Error("Archive snapshot checksum mismatch")
      fsyncSync(fd)
      // Read back bounded chunks: a successful write alone is not durable evidence.
      const diskHash = createHash("sha256")
      const chunk = Buffer.alloc(64 * 1024)
      let position = 0
      for (;;) {
        const bytes = readSync(fd, chunk, 0, chunk.length, position)
        if (bytes === 0) break
        diskHash.update(chunk.subarray(0, bytes))
        position += bytes
      }
      if (diskHash.digest("hex") !== writtenHash.digest("hex")) throw new Error("Archive file checksum mismatch")
      result = { file, records, costMicros: totals[0]!.toString(), sha256 }
    })
    return result!
  } catch (error) {
    // Retain failed artifacts for inspection; the enclosing SQL transaction rolls back.
    throw new Error(redact(`Archive failed; details preserved and artifact retained at ${file}: ${error instanceof Error ? error.message : String(error)}`), { cause: error })
  } finally {
    closeSync(fd)
  }
}
