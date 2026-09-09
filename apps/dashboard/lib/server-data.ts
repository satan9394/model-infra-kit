/**
 * Server-side data loaders used by the pages.
 *
 * Every loader returns a result object instead of throwing, so a page always
 * renders: a missing upstream becomes a banner plus empty states, never a 500.
 */

import { mikTry, type MikResult } from "./mik"
import type {
  BucketsPayload,
  HealthPayload,
  LogsPayload,
  ModelInfo,
  ModelPayload,
  ModelsPayload,
  PricingPayload,
  ProvidersPayload,
  SummaryPayload,
  TrendsPayload,
} from "./types"

export interface ShellData {
  health: HealthPayload | null
  providers: ProvidersPayload["providers"]
  models: ModelsPayload["models"]
  errors: string[]
}

/** Health + the provider/model lists the filter bars need. */
export async function loadShell(): Promise<ShellData> {
  const [health, providers, models] = await Promise.all([
    mikTry<HealthPayload>("/api/health"),
    mikTry<ProvidersPayload>("/api/providers"),
    mikTry<ModelsPayload>("/api/models"),
  ])

  const errors: string[] = []
  if (!health.ok) errors.push(health.error)
  if (!providers.ok) errors.push(providers.error)
  if (!models.ok) errors.push(models.error)

  return {
    health: health.ok ? health.data : null,
    providers: providers.ok ? providers.data.providers : [],
    models: models.ok ? models.data.models : [],
    errors,
  }
}

export function loadSummary(query: string): Promise<MikResult<SummaryPayload>> {
  return mikTry<SummaryPayload>(`/api/usage/summary?${query}`)
}

export function loadTrends(query: string, bucket: "day" | "hour" = "day"): Promise<MikResult<TrendsPayload>> {
  return mikTry<TrendsPayload>(`/api/usage/trends?${query}&bucket=${bucket}`)
}

export function loadBuckets(kind: "by-provider" | "by-model", query: string): Promise<MikResult<BucketsPayload>> {
  return mikTry<BucketsPayload>(`/api/usage/${kind}?${query}`)
}

export function loadLogs(query: string): Promise<MikResult<LogsPayload>> {
  return mikTry<LogsPayload>(`/api/usage/logs?${query}`)
}

export function loadPricing(): Promise<MikResult<PricingPayload>> {
  return mikTry<PricingPayload>("/api/pricing")
}

export function loadProviders(): Promise<MikResult<ProvidersPayload>> {
  return mikTry<ProvidersPayload>("/api/providers")
}

export function loadModels(providerId?: string): Promise<MikResult<ModelsPayload>> {
  return mikTry<ModelsPayload>(providerId ? `/api/models?provider=${encodeURIComponent(providerId)}` : "/api/models")
}

/**
 * `GET /api/models` returns catalogue rows **without** their price card
 * (`ModelCatalog.list` does not call `priceFor`); only `GET /api/models/:ref`
 * attaches `pricing`. The model page needs prices, so it enriches the rows
 * through the detail endpoint with bounded concurrency.
 *
 * Capped on purpose: this is one HTTP call per model, and a 1000-model
 * catalogue is not worth 1000 calls to render a table. Models beyond the cap
 * still show their capabilities, just no price.
 */
export async function loadModelsWithPricing(limit = 150, concurrency = 8): Promise<MikResult<ModelsPayload>> {
  const result = await loadModels()
  if (!result.ok) return result

  const models = result.data.models
  const targets = models.slice(0, limit)
  const enriched = new Map<string, ModelInfo>()

  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const index = cursor
      cursor += 1
      const model = targets[index]
      if (!model) continue
      const detail = await mikTry<ModelPayload>(`/api/models/${encodeURIComponent(model.ref)}`)
      if (detail.ok && detail.data.model.pricing) enriched.set(model.ref, detail.data.model)
    }
  })
  await Promise.all(workers)

  return {
    ok: true,
    data: { models: models.map((model) => enriched.get(model.ref) ?? model) },
  }
}
