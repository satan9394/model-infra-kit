import {
  PricingCatalog,
  costFromRates,
  modelsDevSource,
  pricingCandidates,
  type EstimateArgs,
  type ModelPrice,
  type PricingCatalogState,
  type PricingSource,
  type Rates,
  type RequestFacts,
  type TokenCounts,
} from "llm-pricing"
import { ModelInfraError } from "../errors.js"
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
  /**
   * Explicit catalogue sources. Defaults to llm-pricing's own default
   * (`[modelsDevSource()]`), so an omitted value changes nothing. The HTTP
   * surface validates these URLs before `refresh()` (SSRF guard).
   */
  sources?: PricingSource[]
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
  /**
   * A count the provider did not report stays absent rather than becoming 0 —
   * see `docs/SPEC.md` §4. `Partial` is what lets the AI SDK's own usage shape
   * (`cacheWriteTokens` may be `undefined`) reach this method without a cast.
   */
  usage: Partial<TokenUsage>
}

const MILLION = 1_000_000

/**
 * How many unpriced models are remembered before the set is reset. Bounded so a
 * host that passes per-request model ids (versioned or dated suffixes) through
 * `estimate()` cannot grow this for the life of the process.
 */
const MAX_WARNED_MISSING = 1000

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
  /** The URLs this catalogue will fetch; mirrors `sources` above. */
  private readonly outbound: string[]
  /** Models already reported as unpriced, so a hot path does not spam. */
  private readonly warnedMissing = new Set<string>()
  private lastError: string | undefined
  private loadedOnce = false

  constructor(deps: PricingServiceDeps) {
    this.store = deps.store
    this.onWarn = deps.onWarn ?? (() => {})
    // An injected catalogue owns its source list, which cannot be read back, so
    // `outboundUrls()` has nothing to report for it.
    this.outbound = deps.catalog ? [] : (deps.sources ?? [modelsDevSource()]).map((source) => source.url)
    this.catalog =
      deps.catalog ??
      new PricingCatalog({
        sources: deps.sources,
        cache: createFileCache(expandPath(deps.cacheDir ?? defaultCacheDir())),
        fetch: deps.fetch,
        onWarn: (message, error) => this.onWarn(message, error),
      })
  }

  /** The URLs this catalogue fetches, for the HTTP surface's SSRF guard. */
  outboundUrls(): string[] {
    return this.outbound
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
    // A manual price outranks every catalogue, so a hit must not start a load:
    // `warm()` would queue models.dev's ~4 MB `api.json` for a model whose
    // price is already known locally.
    const manual = this.findOverride(input.model)
    if (manual) return this.manualCost(manual, input.usage, input.model)

    this.warm()

    const estimate = this.catalog.estimate(this.toArgs(input))
    const pricing = estimate.pricing
    if (!pricing) {
      this.warnMissing(input.model)
      // `basis: "unknown"` and not `"flat"` (EVO-G78): no rate was applied at
      // all, and `flat` means the opposite — that a real rate was applied. The
      // amount stays exactly 0; it is never interpolated or estimated.
      return { usd: 0, low: 0, high: 0, basis: "unknown", source: "missing", pricingModel: input.model }
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

  /**
   * `facts` selects a per-request variant of the card — `{ promptTokens }` for a
   * long-context tier, `{ usedReasoning: true }` for thinking mode — so the
   * price a UI shows matches what `estimate()` bills. Omitted, the base card is
   * returned, which is what "what does this model cost" means.
   */
  priceFor(model: string, at?: number, facts?: RequestFacts): ModelPricing | null {
    const manual = this.findOverride(model)
    if (manual) return pricingFromOverride(manual)
    this.warm()
    const card = this.catalog.getPrice(model, at, facts)
    return card ? pricingFromCard(card) : null
  }

  /**
   * A manual price with neither `inputPerM` nor `outputPerM` would bill every
   * request at $0 while still reporting `source: "manual"`, which reads to a
   * host as "my negotiated rate is applied". Refuse it instead.
   */
  setOverride(override: {
    modelId: string
    inputPerM?: number
    outputPerM?: number
    cacheReadPerM?: number
    cacheWritePerM?: number
    displayName?: string
  }): void {
    if (!isRate(override.inputPerM) && !isRate(override.outputPerM)) {
      throw new ModelInfraError(
        `a manual price for "${override.modelId}" needs inputPerM or outputPerM; without one every request would be recorded as $0`,
        { code: "INVALID_REQUEST", model: override.modelId },
      )
    }
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
  private counts(usage: Partial<TokenUsage>): TokenCounts {
    const cacheRead = finite(usage.cacheRead)
    // `TokenCounts` types `inputTokens`/`cachedInputTokens`/`outputTokens` as
    // required numbers, but llm-pricing reads an absent count as absent
    // (`count()` in its `index.mjs`), which is what SPEC §4 asks for. The
    // assertion is the contract's, not ours: a count the provider did not
    // report must reach the library as `undefined`, never as 0.
    return {
      inputTokens: finite(usage.input),
      cachedInputTokens: cacheRead,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: finite(usage.cacheWrite),
      outputTokens: finite(usage.output),
      reasoningOutputTokens: finite(usage.reasoning),
      inputIncludesCache: true,
      reasoningIncludedInOutput: true,
    } as TokenCounts
  }

  private toArgs(input: EstimateInput): EstimateArgs {
    return { ...this.counts(input.usage), model: input.model, at: input.at, perRequest: true }
  }

  private manualCost(override: PricingOverride, usage: Partial<TokenUsage>, requested: string): CostInfo {
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
    // Reset rather than evict one entry: the set is only a de-duplicator, and
    // the worst case after a reset is one extra warning for a model already
    // named once. See `MAX_WARNED_MISSING`.
    if (this.warnedMissing.size >= MAX_WARNED_MISSING) this.warnedMissing.clear()
    this.warnedMissing.add(model)
    this.onWarn(`no price for model "${model}"; cost recorded as $0`)
  }
}

function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A stated per-million rate. A real 0 is a price; `undefined` is not. */
function isRate(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
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
  // Both are part of the card's identity in llm-pricing: dropping them made the
  // price a UI showed disagree with the one a long-context or thinking request
  // was actually billed at.
  if (card.contextTierAbove !== undefined) pricing.contextTierAbove = card.contextTierAbove
  if (card.reasoningMode !== undefined) pricing.reasoningMode = card.reasoningMode
  return pricing
}
