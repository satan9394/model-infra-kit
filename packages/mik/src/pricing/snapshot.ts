import { createHash } from "node:crypto"
import { isModelPricingTier, type ModelPricingTier } from "./tiers.js"

export type ModelPriceSpec = ModelPricingTier
export type PriceModels = Record<string, ModelPriceSpec>
export interface PriceCatalogSnapshot {
  version: number
  exportedAt: string
  entriesCount: number
  checksum: string
  models: PriceModels
}

/** Stable object ordering, including nested rate cards. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function checksum(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

export function priceKey(tier: ModelPriceSpec): string {
  return JSON.stringify([tier.providerId, tier.modelId])
}

export function exportPriceSnapshot(models: PriceModels, exportedAt = new Date().toISOString()): string {
  const body = { version: 1, exportedAt, entriesCount: Object.keys(models).length, models }
  const json = JSON.stringify({ ...body, checksum: checksum(body) }, null, 2)
  const result = importPriceSnapshot(json)
  if (result.errors.length) throw new Error(result.errors.join("; "))
  return json
}

/** Validate everything before returning facts; this pure function never writes a store. */
export function importPriceSnapshot(json: string): { imported: number; errors: string[]; models: PriceModels } {
  const invalid = () => ({ imported: 0, errors: ["Invalid price snapshot (version, checksum or integer micro-USD rates)."], models: {} })
  try {
    const value = JSON.parse(json) as PriceCatalogSnapshot
    if (!value || value.version !== 1 || typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt)) || !value.models || typeof value.models !== "object" || Array.isArray(value.models)) return invalid()
    const { version, exportedAt, entriesCount, models } = value
    if (Object.keys(value).some((key) => !["version", "exportedAt", "entriesCount", "checksum", "models"].includes(key))) return invalid()
    if (!Number.isSafeInteger(entriesCount) || entriesCount !== Object.keys(models).length || value.checksum !== checksum({ version, exportedAt, entriesCount, models })) return invalid()
    for (const [key, tier] of Object.entries(models)) {
      if (!isModelPricingTier(tier) || tier.version !== 1 || !Number.isFinite(Date.parse(tier.updatedAt)) || key !== priceKey(tier)) return invalid()
      if (Object.keys(tier).some((field) => !["modelId", "providerId", "source", "version", "updatedAt", "rates"].includes(field))) return invalid()
      if (Object.keys(tier.rates).some((field) => !["inputMicrosPerMillion", "cachedInputMicrosPerMillion", "cacheWriteMicrosPerMillion", "outputMicrosPerMillion", "reasoningOutputMicrosPerMillion", "longContextThresholdTokens", "longContextInputMultiplier", "longContextOutputMultiplier", "image_per_megapixel_micros", "audio_input_micros_per_second", "audio_output_micros_per_second"].includes(field))) return invalid()
    }
    return { imported: entriesCount, errors: [], models }
  } catch {
    return invalid()
  }
}
