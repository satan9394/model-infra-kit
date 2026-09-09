import type { ProviderConfig, ProviderRecord } from "../types.js"
import { asNumber, asString, toSqlValue, type SqlDriver } from "./driver.js"

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toRecord(row: Record<string, unknown>): ProviderRecord {
  return {
    id: asString(row.id),
    appId: asString(row.app_id, "default"),
    name: asString(row.name),
    protocol: asString(row.protocol, "openai-compatible") as ProviderRecord["protocol"],
    baseUrl: row.base_url ? asString(row.base_url) : undefined,
    apiKeyRef: row.api_key_ref ? asString(row.api_key_ref) : undefined,
    npmPackage: row.npm_package ? asString(row.npm_package) : undefined,
    headers: parseJson<Record<string, string>>(row.headers_json, {}),
    enabled: asNumber(row.enabled, 1) === 1,
    presetId: row.preset_id ? asString(row.preset_id) : undefined,
    meta: parseJson<Record<string, unknown>>(row.meta_json, {}),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  }
}

export class ProviderRepository {
  constructor(private readonly driver: SqlDriver) {}

  list(appId?: string): ProviderRecord[] {
    const rows = appId
      ? this.driver.prepare("SELECT * FROM providers WHERE app_id = ? ORDER BY id").all(appId)
      : this.driver.prepare("SELECT * FROM providers ORDER BY id").all()
    return rows.map(toRecord)
  }

  get(id: string): ProviderRecord | null {
    const row = this.driver.prepare("SELECT * FROM providers WHERE id = ?").get(id)
    return row ? toRecord(row) : null
  }

  upsert(config: ProviderConfig, appId = "default"): ProviderRecord {
    const existing = this.get(config.id)
    const now = Date.now()
    const record: ProviderRecord = {
      ...config,
      protocol: config.protocol ?? existing?.protocol ?? "openai-compatible",
      appId,
      name: config.name ?? existing?.name ?? config.id,
      enabled: config.enabled ?? existing?.enabled ?? true,
      headers: config.headers ?? existing?.headers ?? {},
      meta: config.meta ?? existing?.meta ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.driver
      .prepare(
        `INSERT INTO providers (id, app_id, name, protocol, base_url, api_key_ref, npm_package, headers_json, enabled, preset_id, meta_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           app_id = excluded.app_id,
           name = excluded.name,
           protocol = excluded.protocol,
           base_url = excluded.base_url,
           api_key_ref = excluded.api_key_ref,
           npm_package = excluded.npm_package,
           headers_json = excluded.headers_json,
           enabled = excluded.enabled,
           preset_id = excluded.preset_id,
           meta_json = excluded.meta_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.appId,
        record.name,
        record.protocol,
        toSqlValue(record.baseUrl),
        toSqlValue(record.apiKeyRef),
        toSqlValue(record.npmPackage),
        JSON.stringify(record.headers),
        record.enabled ? 1 : 0,
        toSqlValue(record.presetId),
        JSON.stringify(record.meta),
        record.createdAt,
        record.updatedAt,
      )
    return record
  }

  remove(id: string): boolean {
    const result = this.driver.prepare("DELETE FROM providers WHERE id = ?").run(id)
    return Number(result.changes) > 0
  }

  setEnabled(id: string, enabled: boolean): void {
    this.driver.prepare("UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, Date.now(), id)
  }
}
