/**
 * Wire shapes of the `mik serve` HTTP API, mirrored from `docs/interfaces.md`
 * (T01 `src/types.ts` + T03 `PricingOverride` + T07 response envelopes).
 *
 * They are declared locally on purpose: the dashboard must type-check and build
 * without the main package being built first, and a host may run the dashboard
 * against a `mik serve` from another checkout.
 */

export type Protocol = "openai-compatible" | "openai" | "anthropic" | "google" | "deepseek" | "moonshotai" | "xai"
export type ModelSource = "provider_api" | "models_dev" | "preset" | "manual"
export type PriceSource = "override" | "modelsdev" | "openrouter" | "fallback" | "missing"
export type PriceBasis = "exact" | "flat" | "blended"
export type ApiKeySource = "ref" | "env" | "none"

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
  pricingModel?: string
  providerId?: string
}

export interface ProviderRecord {
  id: string
  appId: string
  name: string
  protocol?: Protocol
  baseUrl?: string
  apiKeyRef?: string
  npmPackage?: string
  headers: Record<string, string>
  enabled: boolean
  presetId?: string
  meta: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface ProviderStatus {
  providerId: string
  ok: boolean
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

export interface ModelPricing {
  inputPerM?: number
  outputPerM?: number
  cacheReadPerM?: number
  cacheWritePerM?: number
  currency: "USD"
  source: PriceSource | "manual"
  displayName?: string
  providerId?: string
  contextTierAbove?: number
  reasoningMode?: boolean
}

export interface ModelInfo {
  providerId: string
  modelId: string
  ref: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities: ModelCapabilities
  pricing?: ModelPricing
  source: ModelSource
  syncedAt?: number
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
  /** Absent when nothing in the range recorded one — never `0` (EVO-G82, R232 F3). */
  avgLatencyMs?: number
  /** Absent when nothing was measured; `formatMs` renders it as `—`. */
  firstTokenMs?: number
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

export interface UsageEvent {
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
  pricingBasis?: string
  pricingSource?: string
}

export interface PricingOverride {
  modelId: string
  displayName?: string
  inputPerM?: number
  outputPerM?: number
  cacheReadPerM?: number
  cacheWritePerM?: number
  updatedAt: number
}

export interface PricingState {
  status: "fresh" | "stale" | "error"
  loadedAt?: number
  source?: string
  lastError?: string
}

/* ---------------------------------------------------------------- envelopes */

export interface HealthPayload {
  status: string
  appId: string
  baseUrl: string
  origin: string
  time: number
  uptimeMs: number
  providers: number
  models: number
  pricing: { status: string; source?: string; loadedAt?: number }
}

export interface ProvidersPayload {
  providers: ProviderRecord[]
}

export interface ProviderPayload {
  provider: ProviderRecord
}

export interface ModelsPayload {
  models: ModelInfo[]
}

export interface ModelPayload {
  model: ModelInfo
}

export interface ProviderStatusPayload {
  status: ProviderStatus
}

export interface PricingPayload {
  state: PricingState
  overrides: PricingOverride[]
}

export interface OverridePayload {
  override: PricingOverride | null
}

export interface SummaryPayload {
  summary: UsageSummary
}

export interface TrendsPayload {
  bucket: "day" | "hour"
  points: UsageTrendPoint[]
}

export interface BucketsPayload {
  buckets: UsageBucket[]
}

export interface LogsPayload {
  total: number
  limit: number
  offset: number
  events: UsageEvent[]
}

export interface LogPayload {
  event: UsageEvent
}

/** The `usage.recorded` / `catalog.updated` / `pricing.updated` SSE frame. */
export interface HubEventFrame {
  type: "usage.recorded" | "catalog.updated" | "pricing.updated"
  at: number
  data: unknown
}
