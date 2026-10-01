import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/store/database.js"
import { PricingService } from "../src/pricing/service.js"
import { exportPriceSnapshot, importPriceSnapshot, priceKey } from "../src/pricing/snapshot.js"
import { deriveModelPricingTier } from "../src/pricing/tiers.js"
import { main } from "../src/cli/index.js"

const tier = deriveModelPricingTier({ modelId: "offline-model", providerId: "local", source: "synced", updatedAt: "2026-10-01T00:00:00.000Z", inputPerM: 1, outputPerM: 2 })
const models = { [priceKey(tier)]: tier }
const json = exportPriceSnapshot(models)

describe("offline price snapshots", () => {
  it("round trips all rate facts with a stable checksum", () => {
    expect(importPriceSnapshot(json)).toEqual({ imported: 1, errors: [], models })
    const shuffled = { ...tier, rates: { outputMicrosPerMillion: tier.rates.outputMicrosPerMillion, inputMicrosPerMillion: tier.rates.inputMicrosPerMillion, ...Object.fromEntries(Object.entries(tier.rates).reverse()) } }
    expect(JSON.parse(exportPriceSnapshot({ [priceKey(tier)]: shuffled }, "2026-10-01T00:00:00.000Z")).checksum).toBe(JSON.parse(exportPriceSnapshot(models, "2026-10-01T00:00:00.000Z")).checksum)
  })
  it.each(["{", "null", "[]", json.replace('"version": 1', '"version": 2'), json.replace('1000000', '1000001'), json.replace('"entriesCount": 1', '"entriesCount": 0')])("rejects corruption without partially importing", (input) => {
    expect(importPriceSnapshot(input).imported).toBe(0)
    expect(importPriceSnapshot(input).errors).not.toHaveLength(0)
  })
  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid rates even when exporting a checksum", (rate) => {
    expect(() => exportPriceSnapshot({ [priceKey(tier)]: { ...tier, rates: { ...tier.rates, inputMicrosPerMillion: rate } } })).toThrow()
  })
  it("allows zero-priced models", () => {
    expect(importPriceSnapshot(exportPriceSnapshot({ [priceKey(tier)]: { ...tier, rates: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } } })).imported).toBe(1)
  })
  it("rejects undeclared secret-bearing metadata even with a newly generated checksum", () => {
    const malicious = { ...tier, rates: { ...tier.rates, apiKey: "private" } }
    expect(() => exportPriceSnapshot({ [priceKey(tier)]: malicious })).toThrow()
    expect(importPriceSnapshot(json.replace('"checksum":', '"apiKey": "private", "checksum":')).imported).toBe(0)
  })
  it("imports general models, preserves overrides, and survives a restart", async () => {
    const store = await Store.open({ path: ":memory:" })
    try {
      const service = new PricingService({ store, autoSync: false })
      service.setOverride({ modelId: "private", inputPerM: 7 })
      expect(service.importSnapshot(json)).toEqual({ imported: 1, errors: [] })
      expect(new PricingService({ store, autoSync: false }).estimate({ model: "offline-model", providerId: "local", usage: { input: 1_000_000 } }).usd).toBe(1)
      expect(service.listOverrides()[0]?.inputPerM).toBe(7)
      expect(service.exportSnapshot()).toContain("offline-model")
      expect(service.importSnapshot("{}").imported).toBe(0)
      expect(store.pricingCache.list()).toHaveLength(1)
    } finally { store.close() }
  })
  it("rolls back all cache writes on a storage failure", async () => {
    const store = await Store.open({ path: ":memory:" })
    try {
      const service = new PricingService({ store, autoSync: false })
      const next = { ...tier, modelId: "second" }
      const set = store.pricingCache.set.bind(store.pricingCache)
      vi.spyOn(store.pricingCache, "set").mockImplementation((value) => { if (value.modelId === "second") throw new Error("write failed"); set(value) })
      expect(() => service.importSnapshot(exportPriceSnapshot({ ...models, [priceKey(next)]: next }))).toThrow("write failed")
      expect(store.pricingCache.list()).toHaveLength(0)
      expect(importPriceSnapshot(service.exportSnapshot()).imported).toBe(0)
    } finally { store.close() }
  })
  it("heals malformed SQLite rates without touching overrides or blocking startup", async () => {
    const store = await Store.open({ path: ":memory:" })
    try {
      store.pricingCache.set(tier)
      store.pricing.set({ modelId: "private", inputPerM: 1 })
      store.driver.exec("UPDATE pricing_cache SET rates_json = 'broken'")
      const warnings: string[] = []
      const service = new PricingService({ store, autoSync: false, onWarn: (message) => warnings.push(message) })
      expect((await service.init()).status).toBe("stale")
      expect(warnings.join()).toContain("bundled catalogue")
      expect(store.pricingCache.listStrict()).toEqual([])
      expect(store.pricing.list()).toHaveLength(1)
      expect(service.priceFor("gpt-4o")).not.toBeNull()
    } finally { store.close() }
  })
  it("redacts read/reset failures and keeps startup working", async () => {
    const store = await Store.open({ path: ":memory:" })
    try {
      vi.spyOn(store.pricingCache, "listStrict").mockImplementation(() => { throw new Error("api_key=hidden123") })
      vi.spyOn(store.pricingCache, "clear").mockImplementation(() => { throw new Error("token=hidden456") })
      const warnings: string[] = []
      await new PricingService({ store, autoSync: false, onWarn: (message) => warnings.push(message) }).init()
      expect(warnings).toHaveLength(2)
      expect(warnings.join()).not.toContain("hidden")
    } finally { store.close() }
  })
  it.each(["en", "zh"])("runs the CLI import/export offline in %s", async (lang) => {
    const cwd = mkdtempSync(join(tmpdir(), "mik-snapshot-"))
    writeFileSync(join(cwd, "in.json"), json)
    const lines: string[] = []
    const run = (args: string[]) => main([...args, "--offline", "--db", join(cwd, "usage.db"), "--cache-dir", join(cwd, "cache"), "--config", join(cwd, "missing.json")], { cwd, env: { MIK_LANG: lang }, io: { out: (text) => lines.push(text), err: (text) => lines.push(text) }, interactive: false })
    expect(await run(["pricing", "import", "--file", "in.json"])).toBe(0)
    expect(await run(["pricing", "export", "--output", "out.json"])).toBe(0)
    expect(importPriceSnapshot(readFileSync(join(cwd, "out.json"), "utf8")).models).toEqual(models)
    expect(lines.join()).toContain(lang === "en" ? "Imported 1" : "已导入 1")
    expect(await run(["pricing", "export", "--output", "out.json"])).toBe(1)
  })
})
