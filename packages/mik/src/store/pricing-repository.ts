import { asNumber, asString, toSqlValue, type SqlDriver } from "./driver.js"

export interface PricingOverride {
  modelId: string
  displayName?: string
  inputPerM?: number
  outputPerM?: number
  cacheReadPerM?: number
  cacheWritePerM?: number
  updatedAt: number
}

function toOverride(row: Record<string, unknown>): PricingOverride {
  return {
    modelId: asString(row.model_id),
    displayName: row.display_name ? asString(row.display_name) : undefined,
    inputPerM: row.input_per_m === null ? undefined : asNumber(row.input_per_m),
    outputPerM: row.output_per_m === null ? undefined : asNumber(row.output_per_m),
    cacheReadPerM: row.cache_read_per_m === null ? undefined : asNumber(row.cache_read_per_m),
    cacheWritePerM: row.cache_write_per_m === null ? undefined : asNumber(row.cache_write_per_m),
    updatedAt: asNumber(row.updated_at),
  }
}

/**
 * User-supplied prices. These outrank every upstream catalogue, so a host that
 * knows its own negotiated rate never has to fight models.dev.
 */
export class PricingRepository {
  constructor(private readonly driver: SqlDriver) {}

  list(): PricingOverride[] {
    return this.driver.prepare("SELECT * FROM pricing_overrides ORDER BY model_id").all().map(toOverride)
  }

  get(modelId: string): PricingOverride | null {
    const row = this.driver.prepare("SELECT * FROM pricing_overrides WHERE model_id = ?").get(modelId)
    return row ? toOverride(row) : null
  }

  set(override: Omit<PricingOverride, "updatedAt"> & { updatedAt?: number }): PricingOverride {
    const record: PricingOverride = { ...override, updatedAt: override.updatedAt ?? Date.now() }
    this.driver
      .prepare(
        `INSERT INTO pricing_overrides (model_id, display_name, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, currency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'USD', ?)
         ON CONFLICT(model_id) DO UPDATE SET
           display_name = excluded.display_name,
           input_per_m = excluded.input_per_m,
           output_per_m = excluded.output_per_m,
           cache_read_per_m = excluded.cache_read_per_m,
           cache_write_per_m = excluded.cache_write_per_m,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.modelId,
        toSqlValue(record.displayName),
        toSqlValue(record.inputPerM),
        toSqlValue(record.outputPerM),
        toSqlValue(record.cacheReadPerM),
        toSqlValue(record.cacheWritePerM),
        record.updatedAt,
      )
    return record
  }

  remove(modelId: string): boolean {
    return Number(this.driver.prepare("DELETE FROM pricing_overrides WHERE model_id = ?").run(modelId).changes) > 0
  }
}

export class SettingsRepository {
  constructor(private readonly driver: SqlDriver) {}

  get(key: string): string | null {
    const row = this.driver.prepare("SELECT value FROM settings WHERE key = ?").get(key)
    return row ? asString(row.value) : null
  }

  set(key: string, value: string): void {
    this.driver
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value)
  }

  delete(key: string): void {
    this.driver.prepare("DELETE FROM settings WHERE key = ?").run(key)
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key)
    if (!raw) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value))
  }
}
