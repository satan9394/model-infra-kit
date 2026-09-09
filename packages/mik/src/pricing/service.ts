import {
  PricingCatalog,
  costFromRates,
  pricingCandidates,
  type EstimateArgs,
  type ModelPrice,
  type PricingCatalogState,
  type Rates,
  type TokenCounts,
} from "llm-pricing"
import type { Store } from "../store/database.js"
import type { PricingOverride } from "../store/pricing-repository.js"
import type { CostInfo, ModelPricing, TokenUsage } from "../types.js"
import { defaultCacheDir, expandPath } from "../util/paths.js"
import { createFileCache } from "./cache.js"

export interface PricingDeps {
  store: Store
  cacheDir?: string
  onWarn?: (m: string, e?: unknown) => void
}

/**
 * `catalog` and `fetch` exist so a test can drive this service with no network
 * at all. Both are optional, so a caller written against `PricingDeps` is
 * unaffected; production leaves them unset.
 */
export interface PricingServiceDeps extends PricingDeps {
  /** An already-configured catalogue, used instead of building one. */
  catalog?: PricingCatalog
  /** Injected into the catalogue this service builds. */
  fetch?: typeof globalThis.fetch
}

export interface PricingState {
  status: "fresh" | "stale" | "error"
  loadedAt?: number
  source?: string
  lastError?: string
}

export interface EstimateInput {
  model: string
  at?: number
  usage: TokenUsage
}

const MILLION = 1_000_000

/**
 * `missing` means "no live catalogue is loaded", which is the offline case: the
 * bundled archive is still answering, so the prices are stale rather than
 * absent. Only a thrown load turns the state into `error`.
 */
const STATUS_BY_CATALOG: Record<PricingCatalogState["status"], PricingState["status"]> = {
  ready: "fresh",
  stale: "stale",
  missing: "stale",
}

/**
 * Cost for a request, resolved against `llm-pricing`.
 *
 * Priority is `pricing_overrides` (manual) > llm-pricing's own overrides >
 * live catalogue > bundled archive. Loading the catalogue never blocks a call
 * and never throws: the archive prices everything while the network is down.
 */
export class PricingService {
  private readonly store: Store
  private readonly onWarn: (m: string, e?: unknown) => void
  private readonly catalog: PricingCatalog
  /** Models already reported as unpriced, so a hot path does not spam. */
  private readonly warnedMissing = new Set<string>()
  private lastError: string | undefined
  private loadedOnce = false

  constructor(deps: PricingServiceDeps) {
    this.store = deps.store
    this.onWarn = deps.onWarn ?? (() => {})
    this.catalog =
      deps.catalog ??
      new PricingCatalog({
        cache: createFileCache(expandPath(deps.cacheDir ?? defaultCacheDir())),
        fetch: deps.fetch,
        onWarn: (message, error) => this.onWarn(message, error),
      })
  }

  /** Never throws: a failure only degrades `state().status`. */
  async init(): Promise<PricingState> {
    return this.load(false)
  }

  /** Never throws. Ignores the freshness window, the backoff and the cache. */
  async refresh(): Promise<PricingState> {
    return this.load(true)
  }

  state(): PricingState {
    const catalogState = this.catalog.state()
    return {
      status: this.lastError === undefined ? STATUS_BY_CATALOG[catalogState.status] : "error",
      loadedAt: catalogState.loadedAt > 0 ? catalogState.loadedAt : undefined,
      source: catalogState.source,
      lastError: this.lastError,
    }
  }

  estimate(input: EstimateInput): CostInfo {
    this.warm()

    const manual = this.findOverride(input.model)
    if (manual) return this.manualCost(manual, input.usage, input.model)

    const estimate = this.catalog.estimate(this.toArgs(input))
    const pricing = estimate.pricing
    if (!pricing) {
      this.warnMissing(input.model)
      return { usd: 0, low: 0, high: 0, basis: "flat", source: "missing", pricingModel: input.model }
    }

    return {
      usd: estimate.cost,
      low: estimate.low,
      high: estimate.high,
      basis: estimate.basis,
      source: pricing.source,
      pricingModel: pricing.displayName ?? input.model,
      providerId: pricing.providerId,
    }
  }

  priceFor(model: string, at?: number): ModelPricing | null {
    const manual = this.findOverride(model)
    if (manual) return pricingFromOverride(manual)
    const card = this.catalog.getPrice(model, at)
    return card ? pricingFromCard(card) : null
  }

  setOverride(override: {
    modelId: string
    inputPerM?: number
    outputPerM?: number
    cacheReadPerM?: number
    cacheWritePerM?: number
    displayName?: string
  }): void {
    this.store.pricing.set(override)
  }

  removeOverride(modelId: string): boolean {
    return this.store.pricing.remove(modelId)
  }

  listOverrides(): PricingOverride[] {
    return this.store.pricing.list()
  }

  /** Passed straight through, for a UI that wants to show match candidates. */
  candidates(model: string): string[] {
    return pricingCandidates(model)
  }

  private async load(force: boolean): Promise<PricingState> {
    try {
      if (force) await this.catalog.refresh()
      else await this.catalog.ensureLoaded()
      this.lastError = undefined
    } catch (error) {
      // Loading prices must never take the host down, and the bundled archive
      // still prices whatever the network does.
      this.lastError = error instanceof Error ? error.message : String(error)
      this.onWarn("pricing catalogue load failed", error)
    }
    this.loadedOnce = true
    return this.state()
  }

  /**
   * `estimate()` is synchronous, so a catalogue that is missing or stale is
   * refreshed behind it. `llm-pricing` deduplicates concurrent loads and backs
   * off after a failure, which makes this safe on a per-request path.
   */
  private warm(): void {
    if (this.loadedOnce && this.catalog.state().status === "ready") return
    void this.load(false).catch(() => undefined)
  }

  /**
   * The `docs/SPEC.md` §4 mapping. A count that is absent stays `undefined`
   * rather than becoming 0: `llm-pricing` reads a missing count and a real zero
   * differently when it decides which rate card a request falls under.
   */
  private counts(usage: TokenUsage): TokenCounts {
    const cacheRead = finite(usage.cacheRead)
    return {
      inputTokens: finite(usage.input),
      cachedInputTokens: cacheRead,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: finite(usage.cacheWrite),
      outputTokens: finite(usage.output),
      reasoningOutputTokens: finite(usage.reasoning),
      inputIncludesCache: true,
      reasoningIncludedInOutput: true,
    } as unknown as TokenCounts
  }

  private toArgs(input: EstimateInput): EstimateArgs {
    return { ...this.counts(input.usage), model: input.model, at: input.at, perRequest: true }
  }

  private manualCost(override: PricingOverride, usage: TokenUsage, requested: string): CostInfo {
    const usd = costFromRates(ratesFromOverride(override), this.counts(usage))
    return {
      usd,
      low: usd,
      high: usd,
      basis: "flat",
      source: "manual",
      pricingModel: override.displayName ?? requested,
    }
  }

  /**
   * `provider:model` reaches us from `ModelRequest` refs, while a manual price
   * is keyed on the model id, so the bare id is tried as a fallback.
   */
  private findOverride(model: string): PricingOverride | null {
    const direct = this.store.pricing.get(model)
    if (direct) return direct
    const colon = model.indexOf(":")
    return colon >= 0 ? this.store.pricing.get(model.slice(colon + 1)) : null
  }

  private warnMissing(model: string): void {
    if (this.warnedMissing.has(model)) return
    this.warnedMissing.add(model)
    this.onWarn(`no price for model "${model}"; cost recorded as $0`)
  }
}

function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Per-million USD → per-token USD. `undefined` for anything not a real rate. */
function perToken(perM: number | undefined): number | undefined {
  return typeof perM === "number" && Number.isFinite(perM) && perM >= 0 ? perM / MILLION : undefined
}

/** Per-token USD → per-million USD, without float noise in the last digits. */
function perMillion(rate: number): number {
  return Number((rate * MILLION).toPrecision(12))
}

function ratesFromOverride(override: PricingOverride): Rates {
  const input = perToken(override.inputPerM) ?? 0
  // An unstated cache rate means "no discount", not "free": billing those
  // tokens at the input rate is the conservative reading of a manual price.
  const cacheRead = perToken(override.cacheReadPerM) ?? input
  const cacheWrite = perToken(override.cacheWritePerM) ?? input
  return {
    inputCostPerToken: input,
    cacheCreationInputCostPerToken: cacheWrite,
    cacheReadInputCostPerToken: cacheRead,
    cachedInputCostPerToken: cacheRead,
    outputCostPerToken: perToken(override.outputPerM) ?? 0,
  }
}

function pricingFromOverride(override: PricingOverride): ModelPricing {
  const pricing: ModelPricing = {
    currency: "USD",
    source: "manual",
    displayName: override.displayName ?? override.modelId,
  }
  if (override.inputPerM !== undefined) pricing.inputPerM = override.inputPerM
  if (override.outputPerM !== undefined) pricing.outputPerM = override.outputPerM
  if (override.cacheReadPerM !== undefined) pricing.cacheReadPerM = override.cacheReadPerM
  if (override.cacheWritePerM !== undefined) pricing.cacheWritePerM = override.cacheWritePerM
  return pricing
}

function pricingFromCard(card: ModelPrice): ModelPricing {
  const pricing: ModelPricing = {
    inputPerM: perMillion(card.inputCostPerToken),
    outputPerM: perMillion(card.outputCostPerToken),
    cacheReadPerM: perMillion(card.cacheReadInputCostPerToken),
    cacheWritePerM: perMillion(card.cacheCreationInputCostPerToken),
    currency: "USD",
    source: card.source,
  }
  if (card.displayName !== undefined) pricing.displayName = card.displayName
  if (card.providerId !== undefined) pricing.providerId = card.providerId
  return pricing
}
