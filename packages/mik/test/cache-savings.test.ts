import { describe, expect, it } from "vitest"
import { cacheSavingsMicros } from "../src/usage/cache-savings.js"
import { deriveModelPricingTier } from "../src/pricing/tiers.js"
import { Store } from "../src/store/database.js"
import { PricingService } from "../src/pricing/service.js"
import { UsageService } from "../src/usage/service.js"
import { createServer } from "../src/server/server.js"
import { ModelInfra } from "../src/hub.js"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tier = deriveModelPricingTier({ modelId: "model", providerId: "p", source: "manual", updatedAt: "2026-10-07", inputPerM: 2, outputPerM: 4, cacheReadPerM: 0.2 })
describe("G122 immutable cache ROI", () => {
  it("calculates exact integer discounts, clamping reported cache tokens and premium rates", () => {
    expect(cacheSavingsMicros(tier, { input: 1000, cacheRead: 800 })).toBe(1440)
    expect(cacheSavingsMicros(tier, { input: 10, cacheRead: 100 })).toBe(18)
    expect(cacheSavingsMicros(tier, { input: 1000, cacheRead: 0 })).toBe(0)
    expect(cacheSavingsMicros({ ...tier, rates: { ...tier.rates, cachedInputMicrosPerMillion: 3_000_000 } }, { input: 100, cacheRead: 100 })).toBe(0)
    expect(cacheSavingsMicros(tier, { input: 1, cacheRead: 1 })).toBe(2)
    expect(() => cacheSavingsMicros(tier, { input: Number.MAX_SAFE_INTEGER, cacheRead: 1 })).toThrow("safe integer")
  })
  it("includes long-context input multipliers without rounding float money", () => {
    const long = { ...tier, rates: { ...tier.rates, longContextThresholdTokens: 100, longContextInputMultiplier: 2 } }
    expect(cacheSavingsMicros(long, { input: 1000, cacheRead: 800 })).toBe(2880)
  })
  it.each([-1, 1.5, NaN, Infinity])("rejects invalid token count %s", count => {
    expect(() => cacheSavingsMicros(tier, { cacheRead: count })).toThrow("safe integers")
  })
  it("uses the provider-specific price tier and manual override", async () => {
    const store = await Store.open({ path: ":memory:" })
    store.pricingCache.set(tier)
    const pricing = new PricingService({ store, autoSync: false, fetch: async () => { throw new Error("offline") } })
    try {
      expect(pricing.cacheSavings({ model: "model", providerId: "p", usage: { input: 1000, cacheRead: 800 } })).toBe(1440)
      pricing.setOverride({ modelId: "model", inputPerM: 3, outputPerM: 4, cacheReadPerM: 1 })
      expect(pricing.cacheSavings({ model: "model", providerId: "p", usage: { input: 1000, cacheRead: 800 } })).toBe(1600)
    } finally { pricing.close(); store.close() }
  })
  it("serves integer savings and hit ratio through HTTP with tenant filtering and archive conservation", async () => {
    const mik = await ModelInfra.init({ appId: "tenant", db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-cache-roi-")), syncCatalog: false, pricingAutoSync: false, onWarn: () => {}, pricingFetch: async () => { throw new Error("offline") } })
    const gateway = await createServer({ hub: mik, port: 0 })
    const now = Date.now() - 86_400_000
    try {
      for (const [id, appId, amount] of [["one", "tenant", 1440], ["two", "tenant", 2], ["other", "other", 1000]] as const) mik.usage.record({
        requestId: id, appId, ts: now, source: "generate", providerId: "p", modelRequested: "model", modelActual: "model",
        usage: { input: 1000, output: 0, cacheRead: 800, cacheWrite: 200, reasoning: 0 }, cost: { usd: 0, low: 0, high: 0, basis: "flat", source: "manual" }, status: "ok", isStreaming: false,
        tags: { _mik_cache_savings_micros: String(amount) },
      })
      const read = async () => (await (await fetch(`${gateway.url}/api/usage/summary?provider=p&model=model`)).json()).summary
      expect(await read()).toMatchObject({ requests: 2, cacheSavingsMicros: 1442, cacheHitRate: 0.8 })
      mik.usage.rollupAndPrune(Date.now(), 30)
      expect(await read()).toMatchObject({ requests: 2, cacheSavingsMicros: 1442, cacheHitRate: 0.8 })
    } finally { await gateway.close(); await mik.close() }
  })
})
