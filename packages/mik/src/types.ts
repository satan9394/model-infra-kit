import type { ModelMessage, ToolSet } from "ai"

/**
 * A wire protocol family. Providers are mapped onto one of these by data,
 * never by `if (providerId === ...)` branching.
 */
export type Protocol =
  | "openai-compatible"
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "moonshotai"
  | "xai"

/** Where a model's metadata or price came from. */
export type ModelSource = "provider_api" | "models_dev" | "preset" | "manual"

/** Where a price came from, mirroring llm-pricing's own vocabulary. */
export type PriceSource = "override" | "modelsdev" | "openrouter" | "fallback" | "missing"

/** How precisely a price could be resolved in time. */
export type PriceBasis = "exact" | "flat" | "blended"

export interface ProviderPreset {
  id: string
  name: string
  protocol: Protocol
  /** Shipped default endpoint; a user may override it. */
  defaultBaseUrl?: string
  /** The `@ai-sdk/*` package that implements this protocol. */
  npmPackage: string
  /** Environment variable the provider conventionally reads its key from. */
  envKey?: string
  docUrl?: string
}

/** A configured provider, as stored. Secrets are referenced, never inlined. */
export interface ProviderConfig {
  id: string
  name?: string
  /**
   * Optional: a `presetId` supplies it, and a bare `baseUrl` implies
   * `openai-compatible`. `ProviderRegistry.add()` resolves the final value.
   */
  protocol?: Protocol
  baseUrl?: string
  /** Reference such as `env:DEEPSEEK_API_KEY` or `file:~/.mik/secrets/deepseek`. */
  apiKeyRef?: string
  npmPackage?: string
  headers?: Record<string, string>
  enabled?: boolean
  presetId?: string
  meta?: Record<string, unknown>
}

export interface ProviderRecord extends ProviderConfig {
  appId: string
  name: string
  enabled: boolean
  headers: Record<string, string>
  meta: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface ProviderStatus {
  providerId: string
  ok: boolean
  /** Human readable, already redacted. */
  message: string
  modelCount?: number
  latencyMs?: number
  checkedAt: number
}

export interface ModelCapabilities {
  text: boolean
  image: boolean
  toolCall: boolean
  reasoning: boolean
  structuredOutput: boolean
}

export interface ModelInfo {
  providerId: string
  modelId: string
  /** `provider:model`, the canonical internal identifier. */
  ref: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities: ModelCapabilities
  pricing?: ModelPricing
  source: ModelSource
  syncedAt?: number
}

export interface ModelPricing {
  inputPerM?: number
  outputPerM?: number
  cacheReadPerM?: number
  cacheWritePerM?: number
  currency: "USD"
  source: PriceSource | "manual"
  displayName?: string
  providerId?: string
}

/** Token counts as reported by a provider, normalised to one shape. */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export interface CostInfo {
  usd: number
  low: number
  high: number
  basis: PriceBasis | "manual"
  source: PriceSource | "manual"
  /** The model id the price was resolved for — not necessarily the requested one. */
  pricingModel?: string
  providerId?: string
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ModelRequest {
  /** `provider:model`, or a bare model id resolved against the default provider. */
  model?: string
  messages: ModelMessage[]
  system?: string
  tools?: ToolSet
  temperature?: number
  maxTokens?: number
  headers?: Record<string, string>
  /** Arbitrary per-call tags, stored with the usage event. */
  tags?: Record<string, string>
  sessionId?: string
  signal?: AbortSignal
}

export interface ModelResponse {
  text: string
  toolCalls: ToolCall[]
  finishReason: string
  usage: TokenUsage
  cost: CostInfo
  provider: string
  model: { requested: string; actual: string }
  latencyMs: number
  firstTokenMs?: number
  steps?: number
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; id: string; name: string; delta: string }
  | { type: "tool_call_complete"; call: ToolCall }
  | { type: "step_finish"; finishReason: string; usage: TokenUsage }
  | { type: "usage"; usage: TokenUsage; cost: CostInfo }
  | { type: "finish"; response: ModelResponse }
  | { type: "error"; error: { code: string; message: string } }

export interface UsageEventInput {
  requestId: string
  appId: string
  ts: number
  source: string
  providerId: string
  modelRequested: string
  modelActual: string
  pricingModel?: string
  usage: TokenUsage
  cost: CostInfo
  latencyMs?: number
  firstTokenMs?: number
  status: "ok" | "error"
  errorCode?: string
  isStreaming: boolean
  sessionId?: string
  tags?: Record<string, string>
}

export interface UsageEvent extends UsageEventInput {
  pricingBasis?: string
  pricingSource?: string
}

export interface UsageSummary {
  requests: number
  successes: number
  failures: number
  successRate: number
  costUsd: number
  costLowUsd: number
  costHighUsd: number
  tokens: TokenUsage
  cacheHitRate: number
  avgLatencyMs: number
  firstTokenMs: number
}

export interface UsageBucket {
  key: string
  requests: number
  costUsd: number
  tokens: TokenUsage
}

export interface UsageTrendPoint {
  date: string
  requests: number
  costUsd: number
  tokens: TokenUsage
}

export interface UsageQuery {
  from?: number
  to?: number
  appId?: string
  providerId?: string
  model?: string
  status?: "ok" | "error"
  sessionId?: string
  limit?: number
  offset?: number
}

export interface UsagePage {
  total: number
  events: UsageEvent[]
}

export interface ModelInfraConfig {
  /** Owning application. Stored on every usage event; lets one DB serve many apps. */
  appId?: string
  /** SQLite file path, or `:memory:`. Defaults to `~/.model-infra-kit/usage.db`. */
  db?: string
  /** Provider presets to register on first run. */
  providers?: ProviderConfig[]
  /** `provider:model` used when a request omits `model`. */
  defaultModel?: string
  /** Auto-load the model catalogue on init. Defaults to true. */
  syncCatalog?: boolean
  /** Persist usage events. Defaults to true. */
  recordUsage?: boolean
  /** Cache directory for the pricing catalogue. Defaults to `~/.model-infra-kit/cache`. */
  cacheDir?: string
  /** Called for non-fatal problems (catalogue sync failure, missing price). */
  onWarn?: (message: string, error?: unknown) => void
}
