import { calculateTierCostMicros, type ModelPricingTier } from "../pricing/tiers.js"
import type { TokenUsage } from "../types.js"

/** Compare the same input with and without the cache discount, in integer micros. */
export function cacheSavingsMicros(tier: ModelPricingTier, usage: Partial<TokenUsage>): number {
  for (const value of [usage.input, usage.cacheRead, usage.cacheWrite]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("Cache token counts must be non-negative safe integers.")
  }
  const inputOnly = { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: 0 }
  const actual = calculateTierCostMicros(tier, inputOnly).costLowMicros
  const full = calculateTierCostMicros({ ...tier, rates: { ...tier.rates, cachedInputMicrosPerMillion: tier.rates.inputMicrosPerMillion } }, inputOnly).costLowMicros
  return Math.max(0, full - actual)
}
