import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LanguageModelUsage } from "ai"
import { PricingCatalog } from "llm-pricing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isModelInfraError } from "../src/errors.js"
import { createFileCache } from "../src/pricing/cache.js"
import { PricingService } from "../src/pricing/service.js"
import { Store } from "../src/store/database.js"
import type { TokenUsage } from "../src/types.js"

const stores: Store[] = []

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
})

async function openStore(): Promise<Store> {
  const store = await Store.open({ path: ":memory:" })
  stores.push(store)
  return store
}

/** Fully offline: no source is configured, so the bundled archive answers. */
function archiveCatalog(onWarn: (m: string, e?: unknown) => void = () => {}) {
  return new PricingCatalog({ sources: [], onWarn })
}

/** Offline the way the network failing looks: a source that cannot be reached. */
function unreachableCatalog(onWarn: (m: string, e?: unknown) => void = () => {}) {
  return new PricingCatalog({
    sources: [{ name: "unreachable", url: "https://offline.invalid/prices.json", parse: () => new Map() }],
    fetch: (async () => {
      throw new Error("network disabled in tests")
    }) as typeof globalThis.fetch,
    onWarn,
  })
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...overrides }
}

/** The value a synchronous throw produced, or `undefined` when it did not throw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

/** `deepseek-chat` in the bundled archive: $0.14/M in, $0.28/M out, $0.0028/M cache. */
const DEEPSEEK_CHAT_1M = usage({ input: 1_000_000, output: 1_000_000 })

describe("PricingService", () => {
  it("maps TokenUsage onto llm-pricing's argument shape", async () => {
    const store = await openStore()
    const catalog = archiveCatalog()
    const spy = vi.spyOn(catalog, "estimate")
    const service = new PricingService({ store, catalog })

    service.estimate({
      model: "deepseek-chat",
      at: 1_700_000_000_000,
      usage: usage({ input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 100_000, reasoning: 50_000 }),
    })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toMatchObject({
      model: "deepseek-chat",
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 100_000,
      outputTokens: 500_000,
      reasoningOutputTokens: 50_000,
      inputIncludesCache: true,
      reasoningIncludedInOutput: true,
      perRequest: true,
      at: 1_700_000_000_000,
    })
  })

  it("passes a missing count as undefined, never as 0", async () => {
    const store = await openStore()
    const catalog = archiveCatalog()
    const spy = vi.spyOn(catalog, "estimate")
    const service = new PricingService({ store, catalog })

    service.estimate({ model: "deepseek-chat", usage: { input: 1000, output: 200 } })

    const args = spy.mock.calls[0]![0]
    expect(args.inputTokens).toBe(1000)
    expect(args.outputTokens).toBe(200)
    expect(args.cachedInputTokens).toBeUndefined()
    expect(args.cacheReadInputTokens).toBeUndefined()
    expect(args.cacheCreationInputTokens).toBeUndefined()
    expect(args.reasoningOutputTokens).toBeUndefined()
    expect(args.at).toBeUndefined()
  })

  it("accepts the AI SDK's usage shape, cacheWriteTokens included as absent", async () => {
    const store = await openStore()
    const catalog = archiveCatalog()
    const spy = vi.spyOn(catalog, "estimate")
    const service = new PricingService({ store, catalog })

    // Exactly what `generateText()` reports when the provider does not split
    // cache writes out: `cacheWriteTokens` is `undefined`, not 0.
    const aiSdk: LanguageModelUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: 1_000_000, reasoningTokens: undefined },
    }

    // The hub's own mapping, with no cast: `EstimateInput.usage` is `Partial`.
    const cost = service.estimate({
      model: "deepseek-chat",
      usage: {
        input: aiSdk.inputTokens,
        output: aiSdk.outputTokens,
        cacheRead: aiSdk.inputTokenDetails.cacheReadTokens,
        cacheWrite: aiSdk.inputTokenDetails.cacheWriteTokens,
        reasoning: aiSdk.outputTokenDetails.reasoningTokens,
      },
    })

    expect(cost.usd).toBeCloseTo(0.42, 12)
    const args = spy.mock.calls[0]![0]
    expect(args.inputTokens).toBe(1_000_000)
    expect(args.outputTokens).toBe(1_000_000)
    expect(args.cacheCreationInputTokens).toBeUndefined()
    expect(args.cachedInputTokens).toBeUndefined()
    expect(args.reasoningOutputTokens).toBeUndefined()
  })

  it("prices an archive model and reports where the price came from", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })

    const cost = service.estimate({ model: "deepseek-chat", usage: DEEPSEEK_CHAT_1M })

    expect(cost.usd).toBeCloseTo(0.42, 12)
    expect(cost.low).toBeCloseTo(0.42, 12)
    expect(cost.high).toBeCloseTo(0.42, 12)
    expect(cost.basis).toBe("flat")
    expect(cost.source).toBe("fallback")
    expect(cost.pricingModel).toBe("DeepSeek Chat")
  })

  it("carves cache tokens out of input and folds reasoning into output", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })

    // fresh = 1_000_000 - 100_000 - 200_000, cache read/write at $0.0028/M.
    const carved = service.estimate({
      model: "deepseek-chat",
      usage: usage({ input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 100_000, reasoning: 50_000 }),
    })
    expect(carved.usd).toBeCloseTo(0.23884, 12)

    // `reasoningIncludedInOutput: true` — thinking tokens must not be billed twice.
    const reasoned = service.estimate({
      model: "deepseek-chat",
      usage: usage({ input: 1_000_000, output: 1_000_000, reasoning: 1_000_000 }),
    })
    expect(reasoned.usd).toBeCloseTo(0.42, 12)
  })

  it("prices a time-sensitive model exactly when `at` is given", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })
    const input = usage({ input: 1_000_000 })

    const peak = service.estimate({ model: "deepseek-v4-flash", at: Date.UTC(2026, 8, 8, 2), usage: input })
    const offPeak = service.estimate({ model: "deepseek-v4-flash", at: Date.UTC(2026, 8, 8, 20), usage: input })

    expect(peak.basis).toBe("exact")
    expect(offPeak.basis).toBe("exact")
    expect(peak.usd).toBeCloseTo(0.44, 12)
    expect(offPeak.usd).toBeCloseTo(0.22, 12)
    // First-party overrides outrank the archive.
    expect(peak.source).toBe("override")
    expect(peak.pricingModel).toBe("DeepSeek V4 Flash")
  })

  it("uses a manual override without consulting the catalogue", async () => {
    const store = await openStore()
    const catalog = archiveCatalog()
    const spy = vi.spyOn(catalog, "estimate")
    const service = new PricingService({ store, catalog })

    store.pricing.set({ modelId: "deepseek-chat", inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 0.5 })
    const cost = service.estimate({
      model: "deepseek-chat",
      usage: usage({ input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }),
    })

    expect(spy).not.toHaveBeenCalled()
    // (700 * 1 + 100 * 0.5 + 200 * 0.1 + 500 * 2) / 1e6
    expect(cost.usd).toBeCloseTo(0.00177, 12)
    expect(cost.basis).toBe("flat")
    expect(cost.source).toBe("manual")
    expect(cost.pricingModel).toBe("deepseek-chat")
  })

  it("never touches the catalogue at all when a manual price hits", async () => {
    const store = await openStore()
    let fetches = 0
    const catalog = new PricingCatalog({
      sources: [{ name: "counted", url: "https://offline.invalid/prices.json", parse: () => new Map() }],
      fetch: (async () => {
        fetches += 1
        throw new Error("network disabled in tests")
      }) as typeof globalThis.fetch,
    })
    const ensureLoaded = vi.spyOn(catalog, "ensureLoaded")
    const estimate = vi.spyOn(catalog, "estimate")
    const service = new PricingService({ store, catalog })

    store.pricing.set({ modelId: "acme-chat", inputPerM: 1, outputPerM: 2 })
    const cost = service.estimate({ model: "acme-chat", usage: usage({ input: 1_000_000 }) })

    // `warm()` would have called `ensureLoaded()` synchronously, queueing the
    // upstream download even though the price never needed it.
    expect(ensureLoaded).not.toHaveBeenCalled()
    expect(estimate).not.toHaveBeenCalled()
    expect(cost.usd).toBeCloseTo(1, 12)

    // Nothing reaches the network either — and the control below proves this
    // counter would have moved if a load had been queued.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetches).toBe(0)

    service.estimate({ model: "deepseek-chat", usage: usage({ input: 1_000_000 }) })
    expect(ensureLoaded).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fetches).toBe(1))
  })

  it("matches a manual override from a `provider:model` ref", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })
    store.pricing.set({ modelId: "deepseek-chat", inputPerM: 1, outputPerM: 1, displayName: "Negotiated" })

    const cost = service.estimate({ model: "deepseek:deepseek-chat", usage: usage({ input: 1_000_000 }) })

    expect(cost.usd).toBeCloseTo(1, 12)
    expect(cost.source).toBe("manual")
    expect(cost.pricingModel).toBe("Negotiated")
  })

  it("treats an unstated manual cache rate as no discount", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })
    store.pricing.set({ modelId: "flat-model", inputPerM: 2, outputPerM: 4 })

    const cost = service.estimate({
      model: "flat-model",
      usage: usage({ input: 1000, output: 100, cacheRead: 400 }),
    })

    // fresh 600 + cache read 400, all at the input rate, plus output.
    expect(cost.usd).toBeCloseTo((1000 * 2 + 100 * 4) / 1_000_000, 12)
  })

  it("refuses a manual price that states neither an input nor an output rate", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })

    const noRates = thrownBy(() => service.setOverride({ modelId: "acme-chat" }))
    expect(isModelInfraError(noRates) && noRates.code).toBe("INVALID_REQUEST")
    expect(isModelInfraError(noRates) && noRates.model).toBe("acme-chat")

    // Cache rates alone would still bill every request at $0.
    expect(() => service.setOverride({ modelId: "acme-chat", cacheReadPerM: 1, cacheWritePerM: 2 })).toThrow(
      /inputPerM or outputPerM/,
    )
    // A negative rate is not a price either.
    expect(() => service.setOverride({ modelId: "acme-chat", inputPerM: -1 })).toThrow(/inputPerM or outputPerM/)
    expect(service.listOverrides()).toEqual([])

    // A stated 0 is a real price (a free model), not a missing one.
    service.setOverride({ modelId: "free-model", inputPerM: 0, outputPerM: 0 })
    expect(service.priceFor("free-model")).toMatchObject({ source: "manual", inputPerM: 0, outputPerM: 0 })
    expect(service.estimate({ model: "free-model", usage: usage({ input: 1_000_000 }) }).usd).toBe(0)

    // What the guard is for: the same row written straight to the store bills
    // every request at $0 while still reporting `source: "manual"`.
    store.pricing.set({ modelId: "silent-zero" })
    expect(service.estimate({ model: "silent-zero", usage: usage({ input: 1_000_000 }) })).toMatchObject({
      usd: 0,
      source: "manual",
    })
  })

  it("returns $0 / missing and warns once for an unpriced model", async () => {
    const store = await openStore()
    const warns: string[] = []
    const service = new PricingService({ store, catalog: archiveCatalog(), onWarn: (m) => warns.push(m) })

    const first = service.estimate({ model: "totally-unknown-model", usage: usage({ input: 10, output: 5 }) })
    const second = service.estimate({ model: "totally-unknown-model", usage: usage({ input: 10, output: 5 }) })

    // EVO-G78 (audit-R232 F2/F12): no rate was applied at all, so the basis is
    // `unknown`. It used to say `flat`, which is the token that means "a real
    // rate was applied" — the CSV could not then tell "free" from "unpriced".
    // The amount stays exactly 0: an unknown price is never interpolated.
    expect(first).toMatchObject({ usd: 0, low: 0, high: 0, basis: "unknown", source: "missing" })
    expect(second.usd).toBe(0)
    expect(warns.filter((m) => m.includes("totally-unknown-model"))).toHaveLength(1)
  })

  it("keeps the warned-missing set bounded across a long-lived process", async () => {
    const store = await openStore()
    const warns: string[] = []
    const service = new PricingService({ store, catalog: archiveCatalog(), onWarn: (m) => warns.push(m) })

    for (let i = 0; i < 1001; i += 1) {
      service.estimate({ model: `unknown-model-${i}`, usage: usage({ input: 1 }) })
    }

    const missing = warns.filter((m) => m.includes("no price for model"))
    expect(missing).toHaveLength(1001)
    // Test-only read of the private de-duplicator: the point of S14 is that
    // this structure cannot grow with the number of distinct model ids.
    const warned = (service as unknown as { warnedMissing: Set<string> }).warnedMissing
    expect(warned.size).toBeLessThanOrEqual(1000)

    // The set was reset at the cap, so the first model is no longer remembered...
    service.estimate({ model: "unknown-model-0", usage: usage({ input: 1 }) })
    expect(warns.filter((m) => m.includes("no price for model"))).toHaveLength(1002)
    // ...while a model still in the set is not warned about twice.
    service.estimate({ model: "unknown-model-1000", usage: usage({ input: 1 }) })
    expect(warns.filter((m) => m.includes("no price for model"))).toHaveLength(1002)
  })

  it("never throws when every source is unreachable, and still prices", async () => {
    const store = await openStore()
    const warns: string[] = []
    const service = new PricingService({ store, catalog: unreachableCatalog((m) => warns.push(m)) })

    expect((await service.init()).status).toBe("stale")
    expect(warns.join(" ")).toContain("unreachable")

    expect((await service.refresh()).status).toBe("stale")
    expect(service.state().status).toBe("stale")
    expect(service.state().source).toBe("fallback")

    expect(service.estimate({ model: "deepseek-chat", usage: DEEPSEEK_CHAT_1M }).usd).toBeCloseTo(0.42, 12)
  })

  it("degrades to error instead of throwing when the catalogue itself fails", async () => {
    const store = await openStore()
    const warns: string[] = []
    const failing = {
      state: () => ({ status: "missing" as const, loadedAt: 0, source: "fallback", size: 0 }),
      ensureLoaded: () => Promise.reject(new Error("catalogue unavailable")),
      refresh: () => Promise.reject(new Error("catalogue unavailable")),
    } as unknown as PricingCatalog
    const service = new PricingService({ store, catalog: failing, onWarn: (m) => warns.push(m) })

    const state = await service.init()

    expect(state.status).toBe("error")
    expect(state.lastError).toBe("catalogue unavailable")
    expect(warns.join(" ")).toContain("pricing catalogue load failed")
    expect((await service.refresh()).status).toBe("error")
  })

  it("reports a resolved price and null for an unknown model", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })

    expect(service.priceFor("deepseek-chat")).toMatchObject({
      inputPerM: 0.14,
      outputPerM: 0.28,
      cacheReadPerM: 0.0028,
      cacheWritePerM: 0.0028,
      currency: "USD",
      source: "fallback",
      displayName: "DeepSeek Chat",
    })
    expect(service.priceFor("totally-unknown-model")).toBeNull()
  })

  it("warms the catalogue from `priceFor` the way `estimate` does", async () => {
    const store = await openStore()
    const catalog = archiveCatalog()
    const ensureLoaded = vi.spyOn(catalog, "ensureLoaded")
    const service = new PricingService({ store, catalog })

    service.priceFor("deepseek-chat")

    expect(ensureLoaded).toHaveBeenCalledTimes(1)
  })

  it("reports the long-context tier and the thinking card `priceFor` resolved", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })

    // `qwen-plus` in the bundled archive: $0.4/M in, $1.2/M out, x3 above
    // 256k, and $4/M out in thinking mode.
    expect(service.priceFor("qwen-plus")).toMatchObject({ inputPerM: 0.4, outputPerM: 1.2, source: "fallback" })
    expect(service.priceFor("qwen-plus")?.contextTierAbove).toBeUndefined()
    expect(service.priceFor("qwen-plus")?.reasoningMode).toBeUndefined()

    expect(service.priceFor("qwen-plus", undefined, { promptTokens: 300_000 })).toMatchObject({
      inputPerM: 1.2,
      outputPerM: 3.6,
      contextTierAbove: 256_000,
    })
    expect(service.priceFor("qwen-plus", undefined, { usedReasoning: true })).toMatchObject({
      outputPerM: 4,
      reasoningMode: true,
    })
  })

  it("passes the quoting provider through from the resolved card", async () => {
    const store = await openStore()
    const card = {
      inputCostPerToken: 1e-6,
      outputCostPerToken: 2e-6,
      cacheCreationInputCostPerToken: 1e-6,
      cacheReadInputCostPerToken: 1e-6,
      cachedInputCostPerToken: 1e-6,
      source: "modelsdev" as const,
      providerId: "acme",
      displayName: "Acme Chat",
      contextTierAbove: 200_000,
      reasoningMode: true,
    }
    // The bundled archive quotes first-party rates only, so a provider id can
    // only come from a live catalogue; a stub is the only way to cover this.
    const stub = {
      state: () => ({ status: "missing" as const, loadedAt: 0, source: "modelsdev", size: 1 }),
      ensureLoaded: () => Promise.resolve(),
      getPrice: () => card,
      estimate: () => ({ cost: 0.5, low: 0.5, high: 0.5, basis: "flat" as const, pricing: card, tokens: 3 }),
    } as unknown as PricingCatalog
    const service = new PricingService({ store, catalog: stub })

    expect(service.estimate({ model: "acme-chat", usage: usage({ input: 1_000_000 }) })).toMatchObject({
      usd: 0.5,
      source: "modelsdev",
      providerId: "acme",
    })
    expect(service.priceFor("acme-chat")).toMatchObject({
      source: "modelsdev",
      providerId: "acme",
      contextTierAbove: 200_000,
      reasoningMode: true,
    })
  })

  it("reports a manual price as such and manages overrides", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })

    service.setOverride({ modelId: "acme-chat", inputPerM: 3, outputPerM: 6, displayName: "Acme Chat" })

    expect(service.priceFor("acme-chat")).toMatchObject({ source: "manual", inputPerM: 3, outputPerM: 6, displayName: "Acme Chat" })
    expect(service.listOverrides().map((o) => o.modelId)).toEqual(["acme-chat"])
    expect(service.removeOverride("acme-chat")).toBe(true)
    expect(service.removeOverride("acme-chat")).toBe(false)
    expect(service.listOverrides()).toEqual([])
  })

  it("passes pricingCandidates through unchanged", async () => {
    const store = await openStore()
    const service = new PricingService({ store, catalog: archiveCatalog() })

    // Asserting equality against `pricingCandidates(x)` would just call the
    // same function twice; the concrete candidate is the real assertion.
    expect(service.candidates("deepseek-chat")).toContain("deepseek-chat")
  })

  it("keeps the catalogue under cacheDir so a second service does not re-download", async () => {
    const store = await openStore()
    const dir = mkdtempSync(join(tmpdir(), "mik-pricing-cache-"))
    const payload = JSON.stringify({
      acme: { id: "acme", name: "Acme", models: { "acme-chat": { id: "acme-chat", name: "Acme Chat", cost: { input: 1, output: 2 } } } },
    })
    let downloads = 0
    const online = (async () => {
      downloads += 1
      return new Response(payload, { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const first = new PricingService({ store, cacheDir: dir, fetch: online })
    expect((await first.init()).status).toBe("fresh")
    expect(downloads).toBe(1)
    expect(readdirSync(dir).some((name) => name.endsWith(".json"))).toBe(true)

    const offlineFetch = (async () => {
      downloads += 1
      throw new Error("offline")
    }) as unknown as typeof globalThis.fetch
    const second = new PricingService({ store, cacheDir: dir, fetch: offlineFetch })

    expect((await second.init()).status).toBe("fresh")
    expect(downloads).toBe(1)
    expect(second.estimate({ model: "acme-chat", usage: DEEPSEEK_CHAT_1M }).usd).toBeCloseTo(3, 12)
  })

  it("caches catalogue payloads on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mik-pricing-files-"))
    const cache = createFileCache(dir)
    const key = "https://example.invalid/api.json"

    expect(await cache.get(key)).toBeNull()
    await cache.set(key, '{"ok":true}')
    expect(await cache.get(key)).toBe('{"ok":true}')
    await cache.set(key, '{"ok":false}')
    expect(await cache.get(key)).toBe('{"ok":false}')
  })
})
