import { afterEach, expect, it } from "vitest"
import { PricingCatalog } from "llm-pricing"
import { PricingService } from "../src/pricing/service.js"
import { Store } from "../src/store/database.js"
import { UsageService } from "../src/usage/service.js"
import { ModelInfra } from "../src/index.js"
import { createServer } from "../src/server/index.js"
const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
it("HTTP summary distinguishes supplier bills, catalogue estimates and unpriced records", async () => {
  const hub = await ModelInfra.init({ appId: "g142", db: ":memory:", syncCatalog: false, cacheDir: ".tmp/g142-api-cache", pricingFetch: async () => { throw new Error("offline test") }, onWarn: () => {} })
  const server = await createServer({ hub, port: 0, heartbeatMs: 0 })
  try {
    for (const [model, source, basis, usd] of [["bill", "provider", "exact", 0.000001], ["estimate", "modelsdev", "flat", 0.00003], ["unknown", "missing", "unknown", 0]] as const) hub.usage.record({
      requestId: model, ts: Date.now(), source: "report", providerId: "p", modelRequested: model, modelActual: model, status: "ok", isStreaming: false,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd, low: usd, high: usd, source, basis },
    })
    for (const [model, accuracy] of [["bill", "exact"], ["estimate", "estimate"], ["unknown", "unknown"]]) {
      const { summary } = await (await fetch(`${server.url}/api/usage/summary?model=${model}`)).json()
      expect(summary.costAccuracy).toBe(accuracy)
    }
    const { summary } = await (await fetch(`${server.url}/api/usage/summary`)).json()
    expect(summary).toMatchObject({ costAccuracy: "unknown", unpricedRequests: 1, exactRequests: 1, retainedRequests: 3, costLowUsd: 0.000031 })
    hub.pricing.setOverride({ modelId: "deepseek-chat", inputPerM: 9, outputPerM: 10 })
    const pricing = await (await fetch(`${server.url}/api/pricing`)).json()
    expect(pricing.prices.find((item: { modelId: string }) => item.modelId === "deepseek-chat")).toMatchObject({ effective: { inputPerM: 9, source: "manual" }, baseline: { source: "fallback" } })
    expect(hub.pricing.listOverrides()).toHaveLength(1)
  } finally { await server.close(); await hub.close() }
})
it("fallback preview is identical to post-revoke price and does not remove overrides", async () => {
  const store = await Store.open({ path: ":memory:" }); stores.push(store)
  const service = new PricingService({ store, catalog: new PricingCatalog({ sources: [] }), autoSync: false })
  service.setOverride({ modelId: "deepseek-chat", inputPerM: 9, outputPerM: 10 })
  const baseline = service.priceAfterRemovingOverride("deepseek-chat")
  expect(baseline?.source).toBe("fallback")
  expect(service.priceFor("deepseek-chat")?.inputPerM).toBe(9)
  expect(service.listOverrides()).toHaveLength(1)
  service.removeOverride("deepseek-chat")
  expect(service.priceFor("deepseek-chat")).toEqual(baseline)
  expect(service.priceAfterRemovingOverride("g142-unknown-model")).toBeNull()
})
it("qualified override preview preserves the remaining bare-model override", async () => {
  const store = await Store.open({ path: ":memory:" }); stores.push(store)
  const service = new PricingService({ store, catalog: new PricingCatalog({ sources: [] }), autoSync: false })
  service.setOverride({ modelId: "deepseek-chat", inputPerM: 5, outputPerM: 6 })
  service.setOverride({ modelId: "p:deepseek-chat", inputPerM: 9, outputPerM: 10 })
  const preview = service.priceAfterRemovingOverride("p:deepseek-chat")
  expect(preview?.inputPerM).toBe(5)
  expect(preview?.source).toBe("manual")
  expect(service.priceFor("p:deepseek-chat")?.inputPerM).toBe(9)
  service.removeOverride("p:deepseek-chat")
  expect(service.priceFor("p:deepseek-chat")).toEqual(preview)
})
it("provenance counts only retained supplier bills and respects app/filter scope", async () => {
  const store = await Store.open({ path: ":memory:" }); stores.push(store)
  const usage = new UsageService({ store, appId: "app", enabled: true })
  for (const [requestId, appId, source, basis] of [["bill", "app", "provider", "exact"], ["estimate", "app", "manual", "manual"], ["foreign", "other", "provider", "exact"], ["missing", "app", "missing", "unknown"]] as const) {
    store.usage.insert({ requestId, appId, ts: 100, source: "report", providerId: "p", modelRequested: "m", modelActual: "m", status: "ok", isStreaming: false,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: 0.000001, low: 0.000001, high: 0.000001, source, basis } })
  }
  expect(usage.costProvenance()).toEqual({ exactRequests: 1, retainedRequests: 3 })
  expect(usage.costProvenance({ from: 101 })).toEqual({ exactRequests: 0, retainedRequests: 0 })
  expect(usage.summary().costLowUsd).toBe(0.000003)
  const before = usage.summary()
  store.usage.rollup(101)
  expect(usage.summary().costLowUsd).toBe(before.costLowUsd)
  expect(usage.summary().costHighUsd).toBe(before.costHighUsd)
  expect(usage.summary().tokens).toEqual(before.tokens)
  expect(usage.costProvenance()).toEqual({ exactRequests: 0, retainedRequests: 0 })
})
