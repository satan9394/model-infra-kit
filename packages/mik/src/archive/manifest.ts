import { createHash } from "node:crypto"
import { redactDeep } from "../util/redact.js"

export interface ArchiveShard {
  file: string
  records: number
  sha256: string
  costMicros: string
  savingsMicros: string
}
export interface ArchiveManifest {
  version: "1.0"
  exportedAt: string
  beforeDate: string
  cutoffMs: number
  scope: "all-apps"
  totalRecords: number
  totalCostMicros: string
  totalSavingsMicros: string
  dataChecksum: string
  shards: ArchiveShard[]
  manifestChecksum: string
}

export const MAX_RECORD_BYTES = 64 * 1024
export function archiveJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new TypeError("Invalid archive JSON") }
}
export function micros(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RangeError("Unsafe archive integer")
  return BigInt(value)
}

/** Canonical redacted bytes also bind pruning to the complete record contents. */
export function archiveLine(row: Record<string, unknown>): string {
  const safe = { ...row }
  if (typeof safe.tags_json === "string") safe.tags_json = JSON.stringify(redactDeep(archiveJson(safe.tags_json), 0, 32))
  const line = JSON.stringify(redactDeep(safe, 0, 32)) + "\n"
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new RangeError("Archive record exceeds 64 KiB limit")
  return line
}

/** Fixed field order makes checksums independent of JSON object key order. */
export function manifestChecksum(m: ArchiveManifest): string {
  return createHash("sha256").update(JSON.stringify([
    m.version, m.exportedAt, m.beforeDate, m.cutoffMs, m.scope, m.totalRecords,
    m.totalCostMicros, m.totalSavingsMicros, m.dataChecksum,
    m.shards.map(s => [s.file, s.records, s.sha256, s.costMicros, s.savingsMicros]),
  ])).digest("hex")
}
