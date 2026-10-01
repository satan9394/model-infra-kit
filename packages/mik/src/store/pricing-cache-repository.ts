import { asNumber, asString, type SqlDriver } from "./driver.js"
import { isModelPricingTier, type ModelPricingTier } from "../pricing/tiers.js"

/** Normalized, provider-specific rates copied from a pricing source. */
export class PricingCacheRepository {
  constructor(private readonly driver: SqlDriver) {}

  get(providerId: string, modelId: string): ModelPricingTier | null {
    const row = this.driver
      .prepare("SELECT provider_id, model_id, source, version, rates_json, updated_at FROM pricing_cache WHERE provider_id = ? AND model_id = ?")
      .get(providerId, modelId)
    return row ? toTier(row) : null
  }

  getLatestForModel(modelId: string): ModelPricingTier | null {
    const row = this.driver
      .prepare(
        "SELECT provider_id, model_id, source, version, rates_json, updated_at FROM pricing_cache WHERE model_id = ? ORDER BY updated_at DESC, provider_id LIMIT 1",
      )
      .get(modelId)
    return row ? toTier(row) : null
  }

  list(): ModelPricingTier[] {
    return this.driver
      .prepare(
        "SELECT provider_id, model_id, source, version, rates_json, updated_at FROM pricing_cache ORDER BY model_id, provider_id",
      )
      .all()
      .map(toTier)
      .filter((tier): tier is ModelPricingTier => tier !== null)
  }

  set(tier: ModelPricingTier): void {
    const updatedAt = Date.parse(tier.updatedAt)
    this.driver
      .prepare(
        `INSERT INTO pricing_cache (provider_id, model_id, source, version, rates_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, model_id) DO UPDATE SET
           source = excluded.source,
           version = excluded.version,
           rates_json = excluded.rates_json,
           updated_at = excluded.updated_at`,
      )
      .run(tier.providerId, tier.modelId, tier.source, tier.version, JSON.stringify(tier.rates), Number.isFinite(updatedAt) ? updatedAt : Date.now())
  }

  listStrict(): ModelPricingTier[] {
    return this.driver.prepare("SELECT * FROM pricing_cache ORDER BY model_id, provider_id").all().map((row) => {
      const tier = toTier(row)
      if (!tier || tier.version !== 1 || !Number.isFinite(Date.parse(tier.updatedAt))) throw new Error("Invalid cached price tier")
      return tier
    })
  }

  clear(): void {
    this.driver.prepare("DELETE FROM pricing_cache").run()
  }
}

function toTier(row: Record<string, unknown>): ModelPricingTier | null {
  let rates: unknown
  try {
    rates = JSON.parse(asString(row.rates_json))
  } catch {
    return null
  }

  const tier = {
    providerId: asString(row.provider_id),
    modelId: asString(row.model_id),
    source: asString(row.source),
    version: asNumber(row.version),
    updatedAt: new Date(asNumber(row.updated_at)).toISOString(),
    rates,
  }
  return isModelPricingTier(tier) ? tier : null
}
