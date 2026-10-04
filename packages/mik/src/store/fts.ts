import type { StorageAdapter } from "./adapter.js"
import { redact, redactDeep } from "../util/redact.js"

/** Contentful index: SQLite snippets must never read unsanitized external content. */
export function indexUsage(driver: StorageAdapter, row: Record<string, unknown>): void {
  let tags: unknown = {}
  try { tags = JSON.parse(String(row.tags_json ?? "{}")) } catch { /* Legacy malformed tags have no searchable metadata. */ }
  driver.prepare(`INSERT INTO usage_fts(rowid, trace_id, tags_text, error_message, model, provider)
    VALUES (?, ?, ?, ?, ?, ?)`).run(row.rowid,
    redact(String(row.trace_id ?? "")), redact(JSON.stringify(redactDeep(tags))),
    redact(String(row.error_code ?? "")), redact(String(row.model_actual ?? "")), redact(String(row.provider_id ?? "")))
}

/** Optional SQLite capability, including an atomic, one-time legacy backfill. */
export function initializeFts(driver: StorageAdapter, onWarn?: (message: string) => void): boolean {
  try {
    if (driver.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_fts'").get()) return true
    driver.transaction(() => {
      driver.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS usage_fts USING fts5(
        trace_id, tags_text, error_message, model, provider, tokenize='unicode61')`)
      driver.exec(`CREATE TRIGGER IF NOT EXISTS usage_fts_delete AFTER DELETE ON usage_events
        BEGIN DELETE FROM usage_fts WHERE rowid = old.rowid; END`)
      let after = 0
      for (;;) {
        const rows = driver.prepare(`SELECT rowid AS rowid, trace_id, tags_json, error_code, model_actual, provider_id FROM usage_events
          WHERE rowid > ? AND rowid NOT IN (SELECT rowid FROM usage_fts) ORDER BY rowid LIMIT 256`).all(after)
        if (rows.length === 0) break
        for (const row of rows) { indexUsage(driver, row); after = Number(row.rowid) }
      }
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Custom SQLite-compatible adapters may not provide FTS5; metering still works.
    if (!/no such module.*fts5/i.test(message)) throw error
    try { onWarn?.(redact("SQLite FTS5 is unavailable; full-text search is disabled.")) } catch { /* A diagnostic sink cannot stop metering. */ }
    return false
  }
}
