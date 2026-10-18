import type { StorageAdapter } from "../store/adapter.js"

export interface CacheOptions { ttlMs?: number; maxEntries?: number; approximate?: boolean }
export function readCacheOptions(value: unknown): false | CacheOptions | undefined {
  if (value === undefined || value === false) return value
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("cache must be false or an object")
  const record = value as Record<string, unknown>
  for (const [key, limit] of Object.entries(record)) {
    if (key === "approximate" && typeof limit === "boolean") continue
    if (!["ttlMs", "maxEntries"].includes(key) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Invalid cache limit")
  }
  return { ...(record.ttlMs === undefined ? {} : { ttlMs: record.ttlMs as number }), ...(record.maxEntries === undefined ? {} : { maxEntries: record.maxEntries as number }), approximate: record.approximate === true }
}
interface Entry<T> { value: T; expiresAt: number }

/** Memory LRU with optional SQLite persistence; prompt text is never stored. */
export class LruCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly driver: StorageAdapter | undefined
  private readonly namespace: string
  private readonly now: () => number
  private order = 0

  constructor(options: CacheOptions = {}, driver?: StorageAdapter, namespace = "default", now = Date.now) {
    this.driver = driver
    this.namespace = namespace
    this.now = now
    this.ttlMs = options.ttlMs ?? 86_400_000
    this.maxEntries = options.maxEntries ?? 10_000
    if (![this.ttlMs, this.maxEntries].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("Cache limits must be positive safe integers")
    driver?.exec(`CREATE TABLE IF NOT EXISTS response_cache (namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL, PRIMARY KEY(namespace, key))`)
    if (driver) this.order = Number(driver.prepare("SELECT COALESCE(MAX(accessed_at), 0) AS n FROM response_cache WHERE namespace = ?").get(namespace)?.n ?? 0)
  }

  get(key: string): T | undefined {
    let entry = this.entries.get(key)
    if (!entry && this.driver) {
      const row = this.driver.prepare("SELECT value_json, expires_at FROM response_cache WHERE namespace = ? AND key = ?").get(this.namespace, key)
      if (row) entry = { value: JSON.parse(String(row.value_json)) as T, expiresAt: Number(row.expires_at) }
    }
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      this.driver?.prepare("DELETE FROM response_cache WHERE namespace = ? AND key = ?").run(this.namespace, key)
      return undefined
    }
    this.touch(key, entry)
    this.driver?.prepare("UPDATE response_cache SET accessed_at = ? WHERE namespace = ? AND key = ?").run(++this.order, this.namespace, key)
    return structuredClone(entry.value)
  }

  set(key: string, value: T): void {
    const entry = { value: structuredClone(value), expiresAt: this.now() + this.ttlMs }
    this.touch(key, entry)
    if (!this.driver) return
    this.driver.transaction(() => {
      this.driver!.prepare("INSERT OR REPLACE INTO response_cache VALUES (?, ?, ?, ?, ?)").run(this.namespace, key, JSON.stringify(value), entry.expiresAt, ++this.order)
      this.driver!.prepare("DELETE FROM response_cache WHERE namespace = ? AND (expires_at <= ? OR key NOT IN (SELECT key FROM response_cache WHERE namespace = ? ORDER BY accessed_at DESC LIMIT ?))")
        .run(this.namespace, this.now(), this.namespace, this.maxEntries)
    })
  }

  private touch(key: string, entry: Entry<T>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!)
  }
}
