import { afterEach, describe, expect, it, vi } from "vitest"
import { PricingCatalog } from "llm-pricing"
import { deriveModelPricingTier, calculateTierCostMicros } from "../src/pricing/tiers.js"
import { PricingService } from "../src/pricing/service.js"
import { Store } from "../src/store/database.js"

const stores: Store[] = []

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
})

async function openStore(): Promise<Store> {
  const store = await Store.open({ path: ":memory:" })
  stores.push(store)
  return store
}

function catalogWithGpt6Price(reasoningOutputPerToken = 0.0000005): PricingCatalog {
  return {
    state: () => ({ status: "ready", loadedAt: 1, source: "modelsdev" }),
    ensureLoaded: async () => undefined,
    refresh: async () => undefined,
    getPrice: (model: string, _at?: number, facts?: { usedReasoning?: boolean }) =>
      model.startsWith("gpt-6-")
        ? {
            inputCostPerToken: 0.0000001,
            outputCostPerToken: facts?.usedReasoning ? reasoningOutputPerToken : 0.0000005,
            cacheReadInputCostPerToken: 0.00000001,
            cacheCreationInputCostPerToken: 0.000000125,
            displayName: model,
            source: "modelsdev",
            providerId: "openai",
          }
        : null,
  } as unknown as PricingCatalog
}

describe("EVO-G94 tiered pricing", () => {
  it("derives GPT-6 cache and thinking rates from the base price in integer micros", () => {
    const tier = deriveModelPricingTier({
      modelId: "gpt-6-luna",
      providerId: "openai",
      source: "synced",
      updatedAt: "2026-09-23T00:00:00.000Z",
      inputPerM: 0.1,
      outputPerM: 0.5,
    })

    expect(tier.rates).toEqual({
      inputMicrosPerMillion: 100_000,
      cachedInputMicrosPerMillion: 10_000,
      cacheWriteMicrosPerMillion: 125_000,
      outputMicrosPerMillion: 500_000,
      reasoningOutputMicrosPerMillion: 500_000,
    })
  })

  it("splits cached input, cache writes, text output and reasoning without float accumulation", () => {
    const tier = deriveModelPricingTier({
      modelId: "gpt-6-luna",
      providerId: "openai",
      source: "synced",
      updatedAt: "2026-09-23T00:00:00.000Z",
      inputPerM: 0.1,
      outputPerM: 0.5,
    })

    const cost = calculateTierCostMicros(tier, {
      input: 1_000_000,
      cacheRead: 200_000,
      cacheWrite: 100_000,
      output: 20,
      reasoning: 10,
    })

    expect(cost).toEqual({ costLowMicros: 84_510, costHighMicros: 84_510 })
  })

  it("applies configured long-context multipliers to input and output rates", () => {
    const tier = deriveModelPricingTier({
      modelId: "gpt-6-sol",
      providerId: "openai",
      source: "synced",
      updatedAt: "2026-09-23T00:00:00.000Z",
      inputPerM: 1,
      outputPerM: 2,
      longContextThresholdTokens: 100,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    })

    expect(calculateTierCostMicros(tier, { input: 100, output: 2 })).toEqual({
      costLowMicros: 206,
      costHighMicros: 206,
    })
  })

  it("rounds only after combining token classes into integer micro-USD", () => {
    const tier = deriveModelPricingTier({
      modelId: "gpt-6-astra",
      providerId: "openai",
      source: "synced",
      updatedAt: "2026-09-23T00:00:00.000Z",
      inputPerM: 0.5,
      outputPerM: 0.5,
    })

    expect(calculateTierCostMicros(tier, { input: 1, output: 1 })).toEqual({
      costLowMicros: 1,
      costHighMicros: 1,
    })
  })

  it("uses a SQLite-cached GPT-6 tier hydrated by a fresh service instance", async () => {
    const first = await openStore()
    const tier = deriveModelPricingTier({
      modelId: "gpt-6-luna",
      providerId: "openai",
      source: "synced",
      updatedAt: "2026-09-23T00:00:00.000Z",
      inputPerM: 0.1,
      outputPerM: 0.5,
    })

    first.pricingCache.set(tier)
    const service = new PricingService({ store: first, catalog: new PricingCatalog({ sources: [] }) })
    const cost = service.estimate({
      model: "gpt-6-luna",
      providerId: "openai",
      usage: { input: 1_000_000, output: 20, cacheRead: 200_000, cacheWrite: 100_000, reasoning: 10 },
    })

    expect(cost).toMatchObject({ usd: 0.08451, low: 0.08451, high: 0.08451, source: "modelsdev" })
    expect(first.pricingCache.get("openai", "gpt-6-luna")).toEqual(tier)
  })

  it("syncs only changed provider tiers into SQLite and supports a dry run", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: catalogWithGpt6Price() })

    const preview = await service.sync({ dryRun: true })
    expect(preview).toMatchObject({ syncedModels: 3, updatedModels: 3, dryRun: true })
    expect(store.pricingCache.list()).toHaveLength(0)

    const first = await service.sync()
    expect(first).toMatchObject({ syncedModels: 3, updatedModels: 3, dryRun: false })
    expect(store.pricingCache.get("openai", "gpt-6-luna")).toMatchObject({
      source: "synced",
      rates: {
        inputMicrosPerMillion: 100_000,
        cachedInputMicrosPerMillion: 10_000,
        cacheWriteMicrosPerMillion: 125_000,
        outputMicrosPerMillion: 500_000,
      },
    })

    const unchanged = await service.sync()
    expect(unchanged).toMatchObject({ syncedModels: 3, updatedModels: 0 })
  })

  it("applies the live GPT-6 rate card before the background SQLite sync completes", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: catalogWithGpt6Price() })

    const cost = service.estimate({
      model: "gpt-6-luna",
      providerId: "openai",
      usage: { input: 1_000_000, output: 0, cacheRead: 1_000_000 },
    })

    expect(cost).toMatchObject({ usd: 0.01, low: 0.01, high: 0.01, source: "modelsdev" })
  })

  it("prices thinking tokens at their own rate while keeping them inside output usage", async () => {
    const store = await openStore()
    const service = new PricingService({
      store,
      catalog: catalogWithGpt6Price(0.000001),
      autoSync: false,
    })

    const cost = service.estimate({
      model: "gpt-6-luna",
      providerId: "openai",
      usage: { input: 0, output: 100, reasoning: 50 },
    })

    expect(cost).toMatchObject({ usd: 0.000075, low: 0.000075, high: 0.000075 })
  })

  it("keeps manual GPT-6 base prices authoritative while applying default cache rates", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: new PricingCatalog({ sources: [] }) })
    service.setOverride({ modelId: "gpt-6-sol", inputPerM: 0.1, outputPerM: 0.5 })

    const cost = service.estimate({
      model: "gpt-6-sol",
      usage: { input: 1_000_000, output: 0, cacheRead: 1_000_000 },
    })

    expect(cost).toMatchObject({ usd: 0.01, low: 0.01, high: 0.01, source: "manual" })
  })

  it("returns a warning state instead of throwing when a price sync source fails", async () => {
    const store = await openStore()
    const warnings: string[] = []
    const service = new PricingService({
      store,
      sources: [{ name: "offline", url: "https://offline.invalid/prices.json", parse: () => new Map() }],
      fetch: (async () => {
        throw new Error("offline fixture")
      }) as typeof globalThis.fetch,
      onWarn: (message) => warnings.push(message),
    })

    const result = await service.sync()
    expect(result.syncedModels).toBe(0)
    expect(["stale", "error"]).toContain(result.status)
    expect(warnings.length).toBeGreaterThan(0)
  })

  it("does not wait for a stalled remote source during init", async () => {
    const store = await openStore()
    const never = new Promise<Response>(() => undefined)
    const service = new PricingService({
      store,
      sources: [{ name: "slow", url: "https://offline.invalid/prices.json", parse: () => new Map() }],
      fetch: vi.fn(() => never) as unknown as typeof globalThis.fetch,
    })

    const started = Date.now()
    await service.init()
    expect(Date.now() - started).toBeLessThan(100)
  })
})
