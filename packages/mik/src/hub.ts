import { randomUUID } from "node:crypto"
import { generateText, stepCountIs, streamText, type LanguageModelUsage } from "ai"
import type { PricingCatalog } from "llm-pricing"
import { createAiBridge, type AiBridge } from "./ai/bridge.js"
import { CredentialStore } from "./credential/store.js"
import { isModelInfraError, ModelInfraError, toModelInfraError } from "./errors.js"
import { createMikFetch, type ForwardedCall } from "./fetch.js"
import { PricingService } from "./pricing/service.js"
import { ProviderRegistry, splitModelRef } from "./registry/registry.js"
import { Store } from "./store/database.js"
import type {
  CostInfo,
  ModelInfo,
  ModelInfraConfig,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  TokenUsage,
  ToolCall,
  UsageEvent,
} from "./types.js"
import { UsageService } from "./usage/service.js"
import { redact } from "./util/redact.js"

const DEFAULT_APP_ID = "default"
/** Placeholder until the HTTP server (T07) knows the real port. */
const DEFAULT_BASE_URL = "http://127.0.0.1:0/v1"
/** Tool loops stop here unless the caller says otherwise. */
const DEFAULT_MAX_STEPS = 5
/**
 * `close()` waits this long for an in-flight catalogue sync before closing the
 * store anyway. A sync still running after that is a stalled network request,
 * which is no reason to hang a host's shutdown path.
 */
const CLOSE_SYNC_TIMEOUT_MS = 5_000

/**
 * Shared mutable flags between the instance and the callbacks wired in
 * `init()`. Once the instance is closed it is unusable, so any warning it could
 * still emit is a post-close artefact of the race this fixes — the host must
 * not see it.
 */
interface Lifecycle {
  closed: boolean
}

/**
 * A sync failure the user cannot act on: a provider with no usable credential
 * (the normal state right after `provider add`) or one removed while the sync
 * was running. Both are skipped silently; real network/protocol failures are
 * still reported through `onWarn`.
 */
function isExpectedSyncSkip(error: unknown): boolean {
  return isModelInfraError(error) && (error.code === "CREDENTIAL" || error.code === "PROVIDER_NOT_FOUND")
}

/**
 * `ModelInfraConfig` plus the knobs only this class needs. Everything here is
 * optional, so a plain `ModelInfraConfig` is still a valid argument.
 */
export interface ModelInfraOptions extends ModelInfraConfig {
  /** Public URL of the OpenAI-compatible endpoint. The server injects the port. */
  baseUrl?: string
  /** Retries the AI SDK makes per provider call. Defaults to the SDK's own. */
  maxRetries?: number
  /** Injected pricing catalogue, for offline tests. */
  pricingCatalog?: PricingCatalog
  /** Transport used to load the pricing catalogue; inject a failing one to stay offline. */
  pricingFetch?: typeof globalThis.fetch
  /** Observer called after each usage event is stored. A throw here is contained. */
  onUsage?: (event: UsageEvent) => void
}

/** A `provider:model` reference, resolved against the configured providers. */
export interface ResolvedModelRef {
  providerId: string
  modelId: string
  /** The string the caller asked for, or the configured default reference. */
  requested: string
}

/** The read side of the model catalogue, as exposed on `ModelInfra.models`. */
export interface ModelCatalog {
  list(providerId?: string): ModelInfo[]
  get(ref: string): ModelInfo | null
  refresh(providerId: string): Promise<ModelInfo[]>
}

/** `TokenUsage` as the AI SDK reports it: every count may be absent. */
type OptionalCounts = {
  input: number | undefined
  output: number | undefined
  cacheRead: number | undefined
  cacheWrite: number | undefined
  reasoning: number | undefined
}

function count(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const ZERO_USAGE = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

const MISSING_COST = (): CostInfo => ({ usd: 0, low: 0, high: 0, basis: "flat", source: "missing" })

/**
 * `docs/SPEC.md` §4: the public `TokenUsage` is a total (missing counts are 0),
 * while llm-pricing must be able to tell "the provider did not report this" from
 * "the provider reported zero", so its view keeps the gaps.
 */
function normalizeUsage(raw: LanguageModelUsage | undefined): { usage: TokenUsage; pricing: Partial<TokenUsage> } {
  const counts: OptionalCounts = {
    input: count(raw?.inputTokens),
    output: count(raw?.outputTokens),
    cacheRead: count(raw?.inputTokenDetails?.cacheReadTokens),
    cacheWrite: count(raw?.inputTokenDetails?.cacheWriteTokens),
    reasoning: count(raw?.outputTokenDetails?.reasoningTokens),
  }
  return {
    usage: {
      input: counts.input ?? 0,
      output: counts.output ?? 0,
      cacheRead: counts.cacheRead ?? 0,
      cacheWrite: counts.cacheWrite ?? 0,
      reasoning: counts.reasoning ?? 0,
    },
    // `PricingService.estimate` takes `Partial<TokenUsage>`, so a missing count
    // stays absent (SPEC §4) instead of being flattened to 0 here.
    pricing: counts,
  }
}

function toToolCall(call: { toolCallId: string; toolName: string; input: unknown }): ToolCall {
  return { id: call.toolCallId, name: call.toolName, input: call.input }
}

/**
 * The AI SDK reports an exhausted retry loop as a `RetryError` whose own message
 * carries no status, so the last underlying failure is what has to be
 * classified. Without this, every 5xx would surface as `UNKNOWN`.
 */
function unwrapProviderError(error: unknown, depth = 0): unknown {
  if (depth > 4 || !error || typeof error !== "object") return error
  const record = error as Record<string, unknown>
  const errors = record.errors
  if (Array.isArray(errors) && errors.length > 0) return unwrapProviderError(errors[errors.length - 1], depth + 1)
  return record.cause ? unwrapProviderError(record.cause, depth + 1) : error
}

function toProviderError(error: unknown, context: { providerId?: string; model?: string } = {}): ModelInfraError {
  return toModelInfraError(unwrapProviderError(error), context)
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  return trimmed || DEFAULT_BASE_URL
}

/** Everything `record` needs to write one usage row. */
interface UsageRecordInput {
  requestId: string
  at: number
  source: string
  resolved: ResolvedModelRef
  actual: string
  usage: TokenUsage
  cost: CostInfo
  latencyMs: number
  firstTokenMs?: number
  status: "ok" | "error"
  errorCode?: string
  isStreaming: boolean
  request?: ModelRequest
}

/**
 * The facade a host embeds. After `init()` the three access surfaces —
 * `generate` / `stream` / `fetch` — all route through the same registry,
 * pricing catalogue and usage store, so every call is metered exactly once.
 */
export class ModelInfra {
  /** Owning application; stamped on every usage event. */
  readonly appId: string
  readonly providers: ProviderRegistry
  readonly pricing: PricingService
  readonly usage: UsageService
  readonly models: ModelCatalog
  /** The AI SDK bridge, for provider tests and model discovery (T07 needs it). */
  readonly ai: AiBridge
  /** Drop-in `fetch` for OpenAI-compatible clients. */
  readonly fetch: typeof globalThis.fetch
  /** Settles when the first catalogue sync has finished, successfully or not. */
  readonly catalogSync: Promise<void>

  private readonly store: Store
  private readonly bridge: AiBridge
  private readonly warn: (message: string, error?: unknown) => void
  private readonly lifecycle: Lifecycle
  private readonly maxSteps: number
  private readonly maxRetries: number | undefined
  private closePromise: Promise<void> | undefined
  private baseUrlValue: string

  private constructor(deps: {
    appId: string
    store: Store
    providers: ProviderRegistry
    bridge: AiBridge
    pricing: PricingService
    usage: UsageService
    models: ModelCatalog
    warn: (message: string, error?: unknown) => void
    lifecycle: Lifecycle
    baseUrl: string
    maxSteps: number
    maxRetries: number | undefined
    syncCatalog: boolean
  }) {
    this.appId = deps.appId
    this.store = deps.store
    this.providers = deps.providers
    this.bridge = deps.bridge
    this.ai = deps.bridge
    this.pricing = deps.pricing
    this.usage = deps.usage
    this.models = deps.models
    this.warn = deps.warn
    this.lifecycle = deps.lifecycle
    this.baseUrlValue = deps.baseUrl
    this.maxSteps = deps.maxSteps
    this.maxRetries = deps.maxRetries

    this.fetch = createMikFetch({
      resolveProvider: (providerId) => this.providers.resolve(providerId),
      resolveModel: (model) => this.resolveModel(model),
      onCall: (call) => this.recordForwarded(call),
      baseUrl: () => this.baseUrlValue,
    })

    this.catalogSync = deps.syncCatalog ? this.syncCatalog() : Promise.resolve()
  }

  /**
   * Open the store, wire the sub-services and load the price catalogue.
   *
   * Never throws for a missing provider, an unreachable catalogue or a failed
   * model sync: those degrade with `onWarn`. Only an unusable database or a
   * malformed explicit configuration is fatal.
   */
  static async init(config: ModelInfraOptions = {}): Promise<ModelInfra> {
    const onWarn = config.onWarn ?? (() => {})
    const lifecycle: Lifecycle = { closed: false }
    /** Every warning goes through the lifecycle gate, so `close()` silences the instance. */
    const warn = (message: string, error?: unknown): void => {
      if (lifecycle.closed) return
      onWarn(message, error)
    }
    const appId = config.appId ?? process.env.MIK_APP_ID ?? DEFAULT_APP_ID

    let store: Store
    try {
      store = await Store.open({ path: config.db })
    } catch (error) {
      throw new ModelInfraError(`Could not open the usage database: ${messageOf(error)}`, {
        code: "STORAGE",
        cause: error,
      })
    }

    const credentials = new CredentialStore({ driver: store.driver })
    const providers = new ProviderRegistry({ store, credentials, appId, onWarn: warn })

    try {
      if (config.providers && config.providers.length > 0) providers.seed(config.providers)
      if (config.defaultModel && !providers.defaultModel()) providers.setDefaultModel(config.defaultModel)
    } catch (error) {
      store.close()
      throw error
    }

    const bridge = createAiBridge({ registry: providers, onWarn: warn })

    // `estimate()` is synchronous, so the catalogue is loaded once, up front.
    // `init()` never throws; a failure only downgrades the reported state.
    const pricing = new PricingService({
      store,
      cacheDir: config.cacheDir,
      onWarn: warn,
      catalog: config.pricingCatalog,
      fetch: config.pricingFetch,
    })
    await pricing.init()

    const usage = new UsageService({
      store,
      appId,
      enabled: config.recordUsage ?? true,
      onEvent: config.onUsage ? (event) => safely(() => config.onUsage!(event), warn) : undefined,
    })

    const models: ModelCatalog = {
      list: (providerId) => store.models.list(providerId),
      get: (ref) => {
        const parsed = splitModelRef(ref)
        if (!parsed) return null
        const found = store.models.get(parsed.providerId, parsed.modelId)
        if (!found) return null
        // A single extra lookup is cheap and saves every caller a round trip.
        const card = pricing.priceFor(parsed.modelId)
        return card ? { ...found, pricing: card } : found
      },
      refresh: async (providerId) => {
        if (!providers.get(providerId)) {
          throw new ModelInfraError(`Provider "${providerId}" is not configured.`, {
            code: "PROVIDER_NOT_FOUND",
            providerId,
          })
        }
        const discovered = await bridge.discoverModels(providerId)
        // An empty result means the probe failed; wiping the stored catalogue
        // over a network hiccup would lose data for no reason.
        if (discovered.length > 0) store.models.replaceForProvider(providerId, discovered)
        return store.models.list(providerId)
      },
    }

    return new ModelInfra({
      appId,
      store,
      providers,
      bridge,
      pricing,
      usage,
      models,
      warn,
      lifecycle,
      baseUrl: normalizeBaseUrl(config.baseUrl ?? process.env.MIK_BASE_URL ?? DEFAULT_BASE_URL),
      maxSteps: DEFAULT_MAX_STEPS,
      maxRetries: config.maxRetries,
      syncCatalog: config.syncCatalog ?? true,
    })
  }

  /** The URL an OpenAI-compatible client should be pointed at. */
  get baseUrl(): string {
    return this.baseUrlValue
  }

  /** Called by the HTTP server once it knows the port it bound. */
  setBaseUrl(url: string): void {
    this.baseUrlValue = normalizeBaseUrl(url)
  }

  /**
   * Resolve a request's model reference.
   *
   * `provider:model` is taken literally; a bare id uses the provider of the
   * configured default; nothing at all falls back to the default reference.
   */
  resolveModel(model?: string): ResolvedModelRef {
    const asked = typeof model === "string" ? model.trim() : ""

    if (asked.includes(":")) {
      const parsed = splitModelRef(asked)
      if (!parsed) {
        throw new ModelInfraError(`Invalid model reference "${asked}". Expected "provider:model".`, {
          code: "INVALID_REQUEST",
          model: asked,
        })
      }
      this.assertProvider(parsed.providerId, asked)
      return { providerId: parsed.providerId, modelId: parsed.modelId, requested: asked }
    }

    const fallback = this.providers.defaultModel()
    if (!fallback) {
      throw new ModelInfraError(
        asked
          ? `No default provider is configured, so the bare model "${asked}" cannot be routed. Set a default with providers.setDefaultModel("provider:model").`
          : 'No model was requested and no default model is configured. Pass model as "provider:model" or set a default.',
        { code: "INVALID_REQUEST", model: asked || undefined },
      )
    }
    const parsed = splitModelRef(fallback)
    if (!parsed) {
      throw new ModelInfraError(`The configured default model "${fallback}" is malformed. Expected "provider:model".`, {
        code: "INVALID_REQUEST",
      })
    }
    this.assertProvider(parsed.providerId, fallback)
    return {
      providerId: parsed.providerId,
      modelId: asked || parsed.modelId,
      requested: asked || fallback,
    }
  }

  /** One non-streaming generation, metered whether it succeeds or fails. */
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const resolved = this.resolveModel(request.model)
    const requestId = randomUUID()
    const startedAt = Date.now()

    let model: Awaited<ReturnType<AiBridge["languageModel"]>>
    try {
      model = await this.bridge.languageModel(resolved.providerId, resolved.modelId)
    } catch (error) {
      const mapped = toProviderError(error, { providerId: resolved.providerId, model: resolved.modelId })
      this.record({
        requestId,
        at: startedAt,
        source: "generate",
        resolved,
        actual: resolved.modelId,
        usage: ZERO_USAGE(),
        cost: MISSING_COST(),
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: mapped.code,
        isStreaming: false,
        request,
      })
      throw mapped
    }

    try {
      const result = await generateText({
        model,
        messages: request.messages,
        system: request.system,
        tools: request.tools,
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
        headers: request.headers,
        abortSignal: request.signal,
        maxRetries: this.maxRetries,
        stopWhen: stepCountIs(this.maxSteps),
      })

      // `usage` is documented as the sum over every step in ai@7; `totalUsage`
      // is its deprecated alias, kept as a fallback for older runtimes.
      const { usage, pricing } = normalizeUsage(result.usage ?? result.totalUsage)
      const actual = result.steps.at(-1)?.response?.modelId ?? result.response?.modelId ?? resolved.modelId
      const latencyMs = Date.now() - startedAt
      const firstTokenMs = result.steps.at(-1)?.performance?.timeToFirstOutputMs
      const cost = this.pricing.estimate({ model: actual, at: startedAt, usage: pricing })

      const response: ModelResponse = {
        text: result.text,
        toolCalls: result.toolCalls.map(toToolCall),
        finishReason: String(result.finishReason),
        usage,
        cost,
        provider: resolved.providerId,
        model: { requested: resolved.requested, actual },
        latencyMs,
        firstTokenMs,
        steps: result.steps.length,
      }

      this.record({
        requestId,
        at: startedAt,
        source: "generate",
        resolved,
        actual,
        usage,
        cost,
        latencyMs,
        firstTokenMs,
        status: "ok",
        isStreaming: false,
        request,
      })
      return response
    } catch (error) {
      const mapped = toProviderError(error, { providerId: resolved.providerId, model: resolved.modelId })
      this.record({
        requestId,
        at: startedAt,
        source: "generate",
        resolved,
        actual: resolved.modelId,
        usage: ZERO_USAGE(),
        cost: MISSING_COST(),
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: mapped.code,
        isStreaming: false,
        request,
      })
      throw mapped
    }
  }

  /**
   * One streaming generation. Failures — including an unroutable model — are
   * reported as an `error` event rather than thrown, so a consumer only has one
   * shape to handle. The usage event is recorded before `finish` is emitted.
   */
  stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    return this.runStream(request)
  }

  /**
   * Close the database. The instance is unusable afterwards.
   *
   * The background catalogue sync is not fire-and-forget: closing the store
   * under it is what produced `database is not open` races, so `close()` first
   * waits for it to settle — bounded by `CLOSE_SYNC_TIMEOUT_MS`, after which the
   * store is closed anyway and the late sync is silenced rather than reported.
   * Calling `close()` more than once is a no-op.
   */
  close(): Promise<void> {
    this.closePromise ??= this.closeAfterSync()
    return this.closePromise
  }

  private async closeAfterSync(): Promise<void> {
    await settleWithin(this.catalogSync, CLOSE_SYNC_TIMEOUT_MS)
    // Set before the store goes away: from here on every warning is a race
    // artefact and the host must not see it.
    this.lifecycle.closed = true
    this.store.close()
  }

  private async *runStream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const requestId = randomUUID()
    const startedAt = Date.now()

    let resolved: ResolvedModelRef
    try {
      resolved = this.resolveModel(request.model)
    } catch (error) {
      const mapped = toProviderError(error)
      yield { type: "error", error: { code: mapped.code, message: mapped.message } }
      return
    }

    let model: Awaited<ReturnType<AiBridge["languageModel"]>>
    try {
      model = await this.bridge.languageModel(resolved.providerId, resolved.modelId)
    } catch (error) {
      const mapped = toProviderError(error, { providerId: resolved.providerId, model: resolved.modelId })
      this.record({
        requestId,
        at: startedAt,
        source: "stream",
        resolved,
        actual: resolved.modelId,
        usage: ZERO_USAGE(),
        cost: MISSING_COST(),
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorCode: mapped.code,
        isStreaming: true,
        request,
      })
      yield { type: "error", error: { code: mapped.code, message: mapped.message } }
      return
    }

    const chunks: string[] = []
    const toolCalls: ToolCall[] = []
    const toolNames = new Map<string, string>()
    /** A provider may repeat the same call id across deltas; report it once. */
    const completedCalls = new Set<string>()
    let finishReason = "unknown"
    let steps = 0
    let firstTokenMs: number | undefined
    let stepUsage: TokenUsage | undefined
    let failure: ModelInfraError | undefined
    /**
     * A consumer that stops iterating (`break` after `error`, or after the very
     * first `text_delta`) closes this generator at its current `yield`, so the
     * accounting below never runs. Every write goes through `recordOnce` and the
     * `finally` at the end of this method is the backstop, so exactly one row is
     * written per call no matter where the consumer stops.
     */
    let recorded = false
    const recordOnce = (input: UsageRecordInput): void => {
      if (recorded) return
      recorded = true
      this.record(input)
    }

    const markFirst = () => {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt
    }

    try {
      const result = streamText({
        model,
        messages: request.messages,
        system: request.system,
        tools: request.tools,
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
        headers: request.headers,
        abortSignal: request.signal,
        maxRetries: this.maxRetries,
        stopWhen: stepCountIs(this.maxSteps),
        // The hub reports stream failures as an `error` event and records them,
        // so the SDK must not also write the raw provider error to stderr.
        onError: () => {},
      })

      for await (const part of result.stream) {
        switch (part.type) {
          case "text-delta":
            markFirst()
            chunks.push(part.text)
            yield { type: "text_delta", text: part.text }
            break
          case "tool-input-start":
            toolNames.set(part.id, part.toolName)
            break
          case "tool-input-delta":
            markFirst()
            yield { type: "tool_call_delta", id: part.id, name: toolNames.get(part.id) ?? "", delta: part.delta }
            break
          case "tool-call": {
            markFirst()
            if (completedCalls.has(part.toolCallId)) break
            completedCalls.add(part.toolCallId)
            const call = toToolCall(part)
            toolCalls.push(call)
            yield { type: "tool_call_complete", call }
            break
          }
          case "finish-step": {
            const normalized = normalizeUsage(part.usage)
            stepUsage = normalized.usage
            finishReason = String(part.finishReason)
            steps += 1
            yield { type: "step_finish", finishReason, usage: normalized.usage }
            break
          }
          case "finish":
            finishReason = String(part.finishReason)
            stepUsage = normalizeUsage(part.totalUsage).usage
            break
          case "error":
            failure = toProviderError(part.error, {
              providerId: resolved.providerId,
              model: resolved.modelId,
            })
            yield { type: "error", error: { code: failure.code, message: failure.message } }
            break
          case "abort":
            failure = new ModelInfraError(
              part.reason ? `The stream was aborted: ${redact(part.reason)}` : "The stream was aborted.",
              { code: "TIMEOUT", retryable: true, providerId: resolved.providerId, model: resolved.modelId },
            )
            yield { type: "error", error: { code: failure.code, message: failure.message } }
            break
          default:
            break
        }
      }

      let normalized = stepUsage ? { usage: stepUsage, pricing: stepUsage } : normalizeUsage(undefined)
      let actual = resolved.modelId
      if (!failure) {
        try {
          normalized = normalizeUsage(await result.usage)
        } catch {
          // Fall back to the last step's usage, which is already in hand.
        }
        try {
          actual = (await result.finalStep).response.modelId ?? resolved.modelId
        } catch {
          // Keep the requested model id.
        }
      }

      const latencyMs = Date.now() - startedAt
      // A failed call is not priced: claiming a rate card for a partial stream
      // would put a price source on a row that was never billed end to end.
      const cost = failure ? MISSING_COST() : this.pricing.estimate({ model: actual, at: startedAt, usage: normalized.pricing })
      const response: ModelResponse = {
        text: chunks.join(""),
        toolCalls,
        finishReason,
        usage: normalized.usage,
        cost,
        provider: resolved.providerId,
        model: { requested: resolved.requested, actual },
        latencyMs,
        firstTokenMs,
        steps,
      }

      if (failure) {
        recordOnce({
          requestId,
          at: startedAt,
          source: "stream",
          resolved,
          actual,
          usage: normalized.usage,
          cost,
          latencyMs,
          firstTokenMs,
          status: "error",
          errorCode: failure.code,
          isStreaming: true,
          request,
        })
        return
      }

      yield { type: "usage", usage: normalized.usage, cost }
      // Recorded before `finish`, so a consumer that stops at `finish` can rely
      // on the row already being durable.
      recordOnce({
        requestId,
        at: startedAt,
        source: "stream",
        resolved,
        actual,
        usage: normalized.usage,
        cost,
        latencyMs,
        firstTokenMs,
        status: "ok",
        isStreaming: true,
        request,
      })
      yield { type: "finish", response }
    } catch (error) {
      const mapped = toProviderError(error, { providerId: resolved.providerId, model: resolved.modelId })
      recordOnce({
        requestId,
        at: startedAt,
        source: "stream",
        resolved,
        actual: resolved.modelId,
        usage: stepUsage ?? ZERO_USAGE(),
        cost: MISSING_COST(),
        latencyMs: Date.now() - startedAt,
        firstTokenMs,
        status: "error",
        errorCode: mapped.code,
        isStreaming: true,
        request,
      })
      yield { type: "error", error: { code: mapped.code, message: mapped.message } }
    } finally {
      // The consumer abandoned the stream before the accounting above could run
      // (`return()` on a generator resumes it with a return completion, which
      // runs this block). Meter the call with whatever is known by now, so an
      // abandoned stream still leaves exactly one usage row behind.
      if (!recorded) {
        recordOnce({
          requestId,
          at: startedAt,
          source: "stream",
          resolved,
          actual: resolved.modelId,
          usage: stepUsage ?? ZERO_USAGE(),
          cost: MISSING_COST(),
          latencyMs: Date.now() - startedAt,
          firstTokenMs,
          status: failure ? "error" : "ok",
          errorCode: failure?.code,
          isStreaming: true,
          request,
        })
      }
    }
  }

  private assertProvider(providerId: string, requested: string): void {
    if (this.providers.get(providerId)) return
    throw new ModelInfraError(`Provider "${providerId}" is not configured.`, {
      code: "PROVIDER_NOT_FOUND",
      providerId,
      model: requested,
    })
  }

  /** Meter one call that came in through the `fetch` adapter. */
  private recordForwarded(call: ForwardedCall): void {
    const cost =
      call.status === "ok" ? this.pricing.estimate({ model: call.modelActual, at: call.at, usage: call.usage }) : MISSING_COST()
    this.record({
      requestId: call.requestId,
      at: call.at,
      source: "fetch",
      resolved: { providerId: call.providerId, modelId: call.modelActual, requested: call.modelRequested },
      actual: call.modelActual,
      usage: call.usage,
      cost,
      latencyMs: call.latencyMs,
      firstTokenMs: call.firstTokenMs,
      status: call.status,
      errorCode: call.errorCode,
      isStreaming: call.isStreaming,
    })
  }

  private record(input: UsageRecordInput): void {
    const event: Omit<UsageEvent, "appId"> = {
      requestId: input.requestId,
      ts: input.at,
      source: input.source,
      providerId: input.resolved.providerId,
      modelRequested: input.resolved.requested,
      modelActual: input.actual,
      pricingModel: input.cost.pricingModel,
      usage: input.usage,
      cost: input.cost,
      latencyMs: input.latencyMs,
      firstTokenMs: input.firstTokenMs,
      status: input.status,
      errorCode: input.errorCode,
      isStreaming: input.isStreaming,
      sessionId: input.request?.sessionId,
      tags: input.request?.tags,
    }
    // Metering must never turn a successful call into a failure.
    safely(() => this.usage.record(event), this.warn)
  }

  /**
   * Discover and persist the catalogue of every enabled provider.
   *
   * A disabled provider, or one whose credential cannot be resolved, is an
   * expected state rather than a failure, so it is skipped without `onWarn`.
   * Everything else keeps warning: a real network or protocol failure is what
   * the host needs to know about.
   */
  private async syncCatalog(): Promise<void> {
    try {
      for (const provider of this.providers.list()) {
        if (!provider.enabled) continue
        try {
          this.providers.resolve(provider.id)
        } catch (error) {
          if (!isExpectedSyncSkip(error)) {
            this.warn(`Could not sync models for provider "${provider.id}".`, error)
          }
          continue
        }
        // The store may already be gone; writing through it would only produce
        // the race warning this guards against.
        if (this.lifecycle.closed) return
        try {
          await this.models.refresh(provider.id)
        } catch (error) {
          if (this.lifecycle.closed) return
          this.warn(`Could not sync models for provider "${provider.id}".`, error)
        }
      }
    } catch (error) {
      if (this.lifecycle.closed) return
      this.warn("model catalogue sync failed", error)
    }
  }
}

/**
 * Resolve once `work` settles or `ms` elapses, whichever happens first. The
 * timer is unref'd so a bounded wait can never be the reason a host's process
 * stays alive.
 */
function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
    void work.catch(() => undefined).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function safely(action: () => void, warn: (message: string, error?: unknown) => void): void {
  try {
    action()
  } catch (error) {
    warn("a usage listener failed", error)
  }
}

function messageOf(error: unknown): string {
  return redact(isModelInfraError(error) ? error.message : error instanceof Error ? error.message : String(error))
}
