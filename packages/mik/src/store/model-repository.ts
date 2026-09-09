import type { ModelCapabilities, ModelInfo, ModelSource } from "../types.js"
import { asNumber, asString, toSqlValue, type SqlDriver } from "./driver.js"

const EMPTY_CAPABILITIES: ModelCapabilities = {
  text: true,
  image: false,
  toolCall: false,
  reasoning: false,
  structuredOutput: false,
}

function toModel(row: Record<string, unknown>): ModelInfo {
  let capabilities = EMPTY_CAPABILITIES
  if (typeof row.capabilities_json === "string") {
    try {
      capabilities = { ...EMPTY_CAPABILITIES, ...(JSON.parse(row.capabilities_json) as Partial<ModelCapabilities>) }
    } catch {
      capabilities = EMPTY_CAPABILITIES
    }
  }
  const providerId = asString(row.provider_id)
  const modelId = asString(row.model_id)
  return {
    providerId,
    modelId,
    ref: `${providerId}:${modelId}`,
    displayName: asString(row.display_name) || modelId,
    contextWindow: row.context_window === null ? undefined : asNumber(row.context_window),
    maxOutputTokens: row.max_output_tokens === null ? undefined : asNumber(row.max_output_tokens),
    capabilities,
    source: asString(row.source, "provider_api") as ModelSource,
    syncedAt: asNumber(row.synced_at),
  }
}

export class ModelRepository {
  constructor(private readonly driver: SqlDriver) {}

  list(providerId?: string): ModelInfo[] {
    const rows = providerId
      ? this.driver.prepare("SELECT * FROM provider_models WHERE provider_id = ? ORDER BY model_id").all(providerId)
      : this.driver.prepare("SELECT * FROM provider_models ORDER BY provider_id, model_id").all()
    return rows.map(toModel)
  }

  get(providerId: string, modelId: string): ModelInfo | null {
    const row = this.driver.prepare("SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?").get(providerId, modelId)
    return row ? toModel(row) : null
  }

  /** Replace the whole catalogue of one provider, returning how many were written. */
  replaceForProvider(providerId: string, models: Array<Omit<ModelInfo, "ref"> | ModelInfo>): number {
    const now = Date.now()
    const statement = this.driver.prepare(
      `INSERT INTO provider_models (provider_id, model_id, display_name, source, capabilities_json, context_window, max_output_tokens, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, model_id) DO UPDATE SET
         display_name = excluded.display_name,
         source = excluded.source,
         capabilities_json = excluded.capabilities_json,
         context_window = excluded.context_window,
         max_output_tokens = excluded.max_output_tokens,
         synced_at = excluded.synced_at`,
    )
    this.driver.exec("BEGIN")
    try {
      this.driver.prepare("DELETE FROM provider_models WHERE provider_id = ?").run(providerId)
      for (const model of models) {
        statement.run(
          providerId,
          model.modelId,
          model.displayName ?? model.modelId,
          model.source,
          JSON.stringify(model.capabilities ?? EMPTY_CAPABILITIES),
          toSqlValue(model.contextWindow),
          toSqlValue(model.maxOutputTokens),
          model.syncedAt ?? now,
        )
      }
      this.driver.exec("COMMIT")
    } catch (error) {
      this.driver.exec("ROLLBACK")
      throw error
    }
    return models.length
  }

  remove(providerId: string, modelId: string): void {
    this.driver.prepare("DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?").run(providerId, modelId)
  }
}
