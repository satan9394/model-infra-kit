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
import { MODEL_METADATA } from "../catalog/snapshot.js"
import { defaultCacheDir, expandPath } from "../util/paths.js"
import { createFileCache } from "./cache.js"
import { calculateTierCostMicros, deriveModelPricingTier, type ModelPricingTier } from "./tiers.js"

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
  /** Queue the price-source refresh after reading the local tier cache. Defaults to true. */
  autoSync?: boolean
}

export interface PricingState {
  status: "fresh" | "stale" | "error"
  loadedAt?: number
  source?: string
  lastError?: string
}

export interface PricingSyncOptions {
  force?: boolean
  /** Resolve and report candidate rates without writing them to SQLite. */
  dryRun?: boolean
}

export interface PricingSyncResult extends PricingState {
  syncedModels: number
  updatedModels: number
  dryRun: boolean
}

export interface EstimateInput {
  model: string
  providerId?: string
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
  private readonly autoSync: boolean
  private readonly tiers = new Map<string, ModelPricingTier>()
  /** The URLs this catalogue will fetch; mirrors `sources` above. */
  private readonly outbound: string[]
  /** Models already reported as unpriced, so a hot path does not spam. */
  private readonly warnedMissing = new Set<string>()
  private lastError: string | undefined
  private loadedOnce = false
  private closed = false

  constructor(deps: PricingServiceDeps) {
    this.store = deps.store
    this.onWarn = deps.onWarn ?? (() => {})
    this.autoSync = deps.autoSync ?? true
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
    try {
      for (const tier of this.store.pricingCache.list()) this.tiers.set(tierKey(tier.providerId, tier.modelId), tier)
    } catch (error) {
      this.onWarn("could not read the SQLite pricing cache; using the bundled catalogue", error)
    }
  }

  /** The URLs this catalogue fetches, for the HTTP surface's SSRF guard. */
  outboundUrls(): string[] {
    return this.outbound
  }

  /** Start the remote refresh in the background; opening the local store is enough to start. */
  async init(): Promise<PricingState> {
    const state = this.state()
    if (this.autoSync) this.queueSync(false)
    return state
  }

  /** Never throws. Refreshes the source and persists validated tier changes. */
  async refresh(): Promise<PricingSyncResult> {
    return this.sync({ force: true })
  }

  /** Explicit dynamic pricing sync for embedded hosts and `mik pricing sync`. */
  async sync(options: PricingSyncOptions = {}): Promise<PricingSyncResult> {
    const state = await this.load(options.force ?? true)
    if (this.closed || state.status === "error") {
      return { ...state, syncedModels: 0, updatedModels: 0, dryRun: options.dryRun ?? false }
    }

    const candidates = this.syncedTiers()
    const changed = candidates.filter((tier) => !sameTierRates(this.tiers.get(tierKey(tier.providerId, tier.modelId)), tier))
    if (!options.dryRun) {
      for (const tier of changed) {
        if (this.closed) break
        try {
          this.store.pricingCache.set(tier)
          this.tiers.set(tierKey(tier.providerId, tier.modelId), tier)
        } catch (error) {
          this.onWarn(`could not cache the price for "${tier.modelId}"`, error)
        }
      }
    }
    const updatedModels = options.dryRun
      ? changed.length
      : changed.filter((tier) => sameTierRates(this.tiers.get(tierKey(tier.providerId, tier.modelId)), tier)).length
    return { ...this.state(), syncedModels: candidates.length, updatedModels, dryRun: options.dryRun ?? false }
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
    if (manual) {
      const tier = manualTier(manual, input.model, input.providerId)
      return tier ? tierCost(tier, input.usage, true) : this.manualCost(manual, input.usage, input.model)
    }

    const cachedTier = this.cachedTier(input.model, input.providerId)
    if (cachedTier) return tierCost(cachedTier, input.usage, false)

    this.warm()

    const liveTier = this.liveTier(input.model, input.at, input.providerId, {
      promptTokens: finite(input.usage.input),
      usedReasoning: input.usage.reasoning === undefined ? undefined : input.usage.reasoning > 0,
    })
    if (liveTier) return tierCost(liveTier, input.usage, false)

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
    if (manual) {
      const tier = manualTier(manual, model)
      return tier ? pricingFromTier(tier) : pricingFromOverride(manual)
    }
    const cachedTier = this.cachedTier(model)
    if (cachedTier) return pricingFromTier(cachedTier, facts?.usedReasoning)
    this.warm()
    const liveTier = this.liveTier(model, at, undefined, facts)
    if (liveTier) return pricingFromTier(liveTier, facts?.usedReasoning)
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
    if (this.closed) return this.state()
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
    this.queueSync(false)
  }

  /** Stop background work before the owning Store closes. */
  close(): void {
    this.closed = true
  }

  private queueSync(force: boolean): void {
    void this.sync({ force }).catch((error) => this.onWarn("pricing catalogue load failed", error))
  }

  private cachedTier(model: string, providerId?: string): ModelPricingTier | undefined {
    const modelId = canonicalGpt6Id(model)
    if (!modelId) return undefined
    if (providerId) return this.tiers.get(tierKey(providerId, modelId))
    return [...this.tiers.values()]
      .filter((tier) => tier.modelId === modelId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  }

  private liveTier(model: string, at?: number, providerId?: string, facts?: RequestFacts): ModelPricingTier | undefined {
    const modelId = canonicalGpt6Id(model)
    if (!modelId) return undefined
    const baseFacts = facts?.usedReasoning ? { ...facts, usedReasoning: false } : facts
    const card = this.catalog.getPrice(model, at, baseFacts)
    if (!card || card.source === "fallback") return undefined
    const pricing = pricingFromCard(card)
    if (pricing.inputPerM === undefined || pricing.outputPerM === undefined) return undefined
    const reasoningCard = facts?.usedReasoning ? this.catalog.getPrice(model, at, facts) : undefined
    const reasoningOutputPerM =
      reasoningCard && reasoningCard.source !== "fallback" ? pricingFromCard(reasoningCard).outputPerM : undefined
    const metadata = MODEL_METADATA.find((item) => item.id === modelId)
    const priceProvider = card.providerId ?? metadata?.sourceProviderId ?? providerId
    if (!priceProvider || (providerId && priceProvider !== providerId)) return undefined
    try {
      return tierFromCard(modelId, priceProvider, pricing, "synced", reasoningOutputPerM)
    } catch (error) {
      this.onWarn(`invalid price tier for "${modelId}"; using the bundled catalogue`, error)
      return undefined
    }
  }

  private syncedTiers(): ModelPricingTier[] {
    const tiers: ModelPricingTier[] = []
    for (const model of MODEL_METADATA) {
      if (!canonicalGpt6Id(model.id)) continue
      const card = this.catalog.getPrice(model.id)
      if (!card || card.source === "fallback") continue
      const pricing = pricingFromCard(card)
      if (pricing.inputPerM === undefined || pricing.outputPerM === undefined) continue
      const reasoningCard = this.catalog.getPrice(model.id, undefined, { usedReasoning: true })
      const reasoningOutputPerM =
        reasoningCard && reasoningCard.source !== "fallback" ? pricingFromCard(reasoningCard).outputPerM : undefined
      const providerId = card.providerId ?? model.sourceProviderId
      if (!providerId) continue
      try {
        tiers.push(tierFromCard(model.id, providerId, pricing, "synced", reasoningOutputPerM))
      } catch (error) {
        this.onWarn(`invalid price tier for "${model.id}"; leaving its previous SQLite price intact`, error)
      }
    }
    return tiers
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

function canonicalGpt6Id(model: string): string | undefined {
  const candidate = model.toLowerCase().split(":").at(-1)?.split("/").at(-1)
  return candidate === "gpt-6-luna" || candidate === "gpt-6-sol" || candidate === "gpt-6-astra" ? candidate : undefined
}

function tierKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

function tierFromCard(
  modelId: string,
  providerId: string,
  card: ModelPricing,
  source: ModelPricingTier["source"],
  reasoningOutputPerM?: number,
): ModelPricingTier {
  return deriveModelPricingTier({
    modelId,
    providerId,
    source,
    updatedAt: new Date().toISOString(),
    inputPerM: card.inputPerM!,
    outputPerM: card.outputPerM!,
    cacheReadPerM: card.cacheReadPerM,
    cacheWritePerM: card.cacheWritePerM,
    reasoningOutputPerM,
    longContextThresholdTokens: card.contextTierAbove,
  })
}

function manualTier(override: PricingOverride, model: string, providerId?: string): ModelPricingTier | undefined {
  const modelId = canonicalGpt6Id(model)
  if (!modelId) return undefined
  const metadata = MODEL_METADATA.find((item) => item.id === modelId)
  return deriveModelPricingTier({
    modelId,
    providerId: providerId ?? metadata?.sourceProviderId ?? "manual",
    source: "manual",
    updatedAt: new Date(override.updatedAt).toISOString(),
    inputPerM: override.inputPerM ?? 0,
    outputPerM: override.outputPerM ?? 0,
    cacheReadPerM: override.cacheReadPerM,
    cacheWritePerM: override.cacheWritePerM,
  })
}

function tierCost(tier: ModelPricingTier, usage: Partial<TokenUsage>, manual: boolean): CostInfo {
  const { costLowMicros, costHighMicros } = calculateTierCostMicros(tier, usage)
  const source: CostInfo["source"] = manual ? "manual" : tier.source === "builtin" ? "fallback" : "modelsdev"
  return {
    usd: costLowMicros / MILLION,
    low: costLowMicros / MILLION,
    high: costHighMicros / MILLION,
    basis: manual ? "manual" : "exact",
    source,
    pricingModel: tier.modelId,
    providerId: tier.providerId,
  }
}

function pricingFromTier(tier: ModelPricingTier, usedReasoning?: boolean): ModelPricing {
  const pricing: ModelPricing = {
    inputPerM: tier.rates.inputMicrosPerMillion / MILLION,
    outputPerM:
      (usedReasoning && tier.rates.reasoningOutputMicrosPerMillion !== undefined
        ? tier.rates.reasoningOutputMicrosPerMillion
        : tier.rates.outputMicrosPerMillion) / MILLION,
    cacheReadPerM: (tier.rates.cachedInputMicrosPerMillion ?? tier.rates.inputMicrosPerMillion) / MILLION,
    cacheWritePerM: (tier.rates.cacheWriteMicrosPerMillion ?? tier.rates.inputMicrosPerMillion) / MILLION,
    currency: "USD",
    source: tier.source === "manual" ? "manual" : tier.source === "builtin" ? "fallback" : "modelsdev",
    displayName: tier.modelId,
    providerId: tier.providerId,
    reasoningMode: canonicalGpt6Id(tier.modelId) !== undefined,
  }
  if (tier.rates.longContextThresholdTokens !== undefined) pricing.contextTierAbove = tier.rates.longContextThresholdTokens
  return pricing
}

function sameTierRates(existing: ModelPricingTier | undefined, next: ModelPricingTier): boolean {
  return Boolean(
    existing &&
      existing.source === next.source &&
      existing.version === next.version &&
      JSON.stringify(existing.rates) === JSON.stringify(next.rates),
  )
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
