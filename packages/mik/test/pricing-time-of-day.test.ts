import { describe, expect, it } from "vitest"
import { PricingCatalog } from "llm-pricing"
import { calculateTierCostMicros, deriveModelPricingTier, isModelPricingTier, timeOfDayDiscountAt } from "../src/pricing/tiers.js"
import { PricingService } from "../src/pricing/service.js"
import { pricingRequest } from "../src/pricing/request-context.js"
import { Store } from "../src/store/database.js"

const rule = { startHourUtc: 22, endHourUtc: 6, inputMultiplier: 0.5, outputMultiplier: 0.25 }
const tier = deriveModelPricingTier({ modelId: "gpt-6-sol", providerId: "openai", source: "manual", updatedAt: "2026-10-08T00:00:00Z", inputPerM: 1, outputPerM: 2, timeOfDayDiscounts: [rule] })

describe("UTC discount windows", () => {
  it.each([
    ["2026-10-08T21:59:59.999Z", false], ["2026-10-08T22:00:00Z", true],
    ["2026-10-09T00:00:00Z", true], ["2026-10-09T05:59:59.999Z", true],
    ["2026-10-09T06:00:00Z", false], ["2026-10-08T15:00:00-07:00", true],
    ["2026-10-09T14:00:00+08:00", false],
  ])("classifies %s as %s", (date, active) => {
    expect(Boolean(timeOfDayDiscountAt([rule], Date.parse(date)))).toBe(active)
  })
  it("supports same-day windows and an end at 24", () => {
    const day = { ...rule, startHourUtc: 8, endHourUtc: 16 }
    expect(timeOfDayDiscountAt([day], Date.parse("2026-10-08T08:00Z"))).toEqual(day)
    expect(timeOfDayDiscountAt([day], Date.parse("2026-10-08T16:00Z"))).toBeUndefined()
    expect(timeOfDayDiscountAt([{ ...day, endHourUtc: 24 }], Date.parse("2026-10-08T23:59Z"))).toBeDefined()
  })
  it("rejects invalid rules and timestamps at the cache boundary", () => {
    for (const bad of [{ ...rule, token: "must-not-persist" }, { ...rule, startHourUtc: -1 }, { ...rule, endHourUtc: 6.5 }, { ...rule, inputMultiplier: NaN }, { ...rule, outputMultiplier: 1.1 }, { ...rule, endHourUtc: 22 }]) {
      expect(() => deriveModelPricingTier({ modelId: "m", providerId: "p", source: "manual", updatedAt: "now", inputPerM: 1, outputPerM: 1, timeOfDayDiscounts: [bad] })).toThrow()
      expect(isModelPricingTier({ ...tier, rates: { ...tier.rates, timeOfDayDiscounts: [bad] } })).toBe(false)
    }
    expect(() => timeOfDayDiscountAt([rule], NaN)).toThrow()
  })
  it("stacks batch, long context, cache and reasoning with one integer rounding", () => {
    const card = { ...tier, rates: { ...tier.rates, longContextThresholdTokens: 1, longContextInputMultiplier: 2, longContextOutputMultiplier: 3 } }
    expect(calculateTierCostMicros(card, { input: 1_000_000, cacheRead: 200_000, cacheWrite: 100_000, output: 1_000_000, reasoning: 200_000 }, undefined, { at: Date.parse("2026-10-08T22:00Z"), batch: true }).costLowMicros).toBe(1_172_500)
    expect(calculateTierCostMicros(tier, { input: 1, output: 1 }, undefined, { at: Date.parse("2026-10-08T22:00Z"), batch: true }).costLowMicros).toBe(1)
    expect(calculateTierCostMicros(tier, { input: 1, output: 1 }, undefined, { at: Date.parse("2026-10-08T12:00Z"), batch: true }).costLowMicros).toBe(2)
  })
  it("bills cached rules offline and isolates concurrent request facts", async () => {
    const store = await Store.open({ path: ":memory:" })
    const service = new PricingService({ store, catalog: new PricingCatalog({ sources: [] }), autoSync: false })
    try {
      store.pricingCache.set(tier)
      const cached = new PricingService({ store, catalog: new PricingCatalog({ sources: [] }), autoSync: false })
      const estimate = () => cached.estimate({ model: "gpt-6-sol", providerId: "openai", at: Date.parse("2026-10-08T22:00Z"), usage: { input: 1_000_000, output: 1_000_000 } }).usd
      expect(await Promise.all([true, false].map(batch => pricingRequest.run({ batch }, async () => { await Promise.resolve(); return estimate() })))).toEqual([0.5, 1])
      expect(cached.discountRules(Date.parse("2026-10-08T22:00Z")).find(item => item.modelId === tier.modelId)?.active).toEqual(rule)
      cached.setOverride({ modelId: tier.modelId, inputPerM: 1, outputPerM: 2 })
      expect(cached.discountRules().find(item => item.modelId === tier.modelId)).toBeUndefined()
      cached.close()
    } finally { service.close(); store.close() }
  })
  it("retains local time rules when remote base prices refresh", async () => {
    const store = await Store.open({ path: ":memory:" })
    store.pricingCache.set(tier)
    const catalog = {
      state: () => ({ status: "ready", loadedAt: 1, source: "modelsdev" }),
      refresh: async () => {},
      getPrice: (model: string) => model.startsWith("gpt-6-") ? { inputCostPerToken: 0.000002, outputCostPerToken: 0.000004, cacheReadInputCostPerToken: 0.0000002, cacheCreationInputCostPerToken: 0.0000025, source: "modelsdev", providerId: "openai" } : null,
    } as unknown as PricingCatalog
    const service = new PricingService({ store, catalog, autoSync: false })
    try {
      expect(await service.sync()).toMatchObject({ updatedModels: 3 })
      expect(store.pricingCache.get("openai", "gpt-6-sol")?.rates.timeOfDayDiscounts).toEqual([rule])
      expect(service.estimate({ model: "gpt-6-sol", providerId: "openai", at: Date.parse("2026-10-08T22:00Z"), batch: true, usage: { input: 1_000_000, output: 1_000_000 } }).usd).toBe(1)
    } finally { service.close(); store.close() }
  })
})
