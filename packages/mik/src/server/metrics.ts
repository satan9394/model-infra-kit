import { createHash } from "node:crypto"
import type { ModelInfra } from "../hub.js"
import type { UsageEvent } from "../types.js"
import { requestCostMicrosBigInt } from "../usage/tool-attribution.js"
import { redact } from "../util/redact.js"

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const
const MAX_SERIES_PER_APP = 1024
const TYPES = ["prompt", "completion", "reasoning", "cache"] as const
interface Sample {
  provider: string
  model: string
  requests: { ok: bigint; error: bigint }
  tokens: bigint[]
  micros: bigint
  buckets: bigint[]
  durationMs: number
  count: bigint
}
interface AppSamples { series: Map<string, Sample>; providers: Set<string> }
const count = (value: number | undefined): bigint => Number.isSafeInteger(value) && value! >= 0 ? BigInt(value!) : 0n

/** Redact before bounding/escaping. A suffix keeps distinct redacted identities distinct. */
function identity(value: string, secrets: readonly string[]): string {
  const masked = secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value)
  const clean = redact(masked).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ")
  const suffix = clean !== value || clean.length > 128 || clean === "__other__" || /~[a-f0-9]{16}$/.test(clean)
    ? `~${createHash("sha256").update(value).digest("hex").slice(0, 16)}` : ""
  return clean.slice(0, 128 - suffix.length) + suffix
}
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')
}
function labels(values: Record<string, string>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`
}
function emptySample(provider: string, model: string): Sample {
  return { provider, model, requests: { ok: 0n, error: 0n }, tokens: TYPES.map(() => 0n), micros: 0n,
    buckets: BUCKETS.map(() => 0n), durationMs: 0, count: 0n }
}

/** Per-listener lifetime counters. Scrapes never read the usage database. */
export class MetricsExporter {
  private readonly apps = new Map<string, AppSamples>()
  private readonly subscriptions = new Map<ModelInfra, () => void>()
  private readonly configuredProviders = new WeakMap<ModelInfra, string[]>()
  private readonly secrets: string[] = []
  constructor(private readonly hub: ModelInfra, secrets: readonly string[] = []) {
    this.apps.set(hub.appId, { series: new Map(), providers: new Set(hub.providers.list().map(p => p.id)) })
    this.attach(hub, secrets)
  }

  /** A listener keeps cumulative counters while its routing generations rotate. */
  attach(hub: ModelInfra, secrets: readonly string[]): void {
    this.configuredProviders.set(hub, hub.providers.list().map(provider => provider.id))
    for (const secret of secrets) if (!this.secrets.includes(secret)) this.secrets.push(secret)
    // Newly rotated credentials can coincide with a previously innocuous label.
    for (const app of this.apps.values()) for (const [key, sample] of [...app.series]) {
      if (!this.secrets.some(secret => sample.provider.includes(secret) || sample.model.includes(secret))) continue
      sample.provider = identity(sample.provider, this.secrets)
      sample.model = identity(sample.model, this.secrets)
      const nextKey = key === "overflow" ? key : JSON.stringify([sample.provider, sample.model])
      if (nextKey === key) continue
      app.series.delete(key)
      const existing = app.series.get(nextKey)
      if (!existing) { app.series.set(nextKey, sample); continue }
      existing.requests.ok += sample.requests.ok
      existing.requests.error += sample.requests.error
      existing.micros += sample.micros
      existing.count += sample.count
      existing.durationMs += sample.durationMs
      for (let i = 0; i < TYPES.length; i++) existing.tokens[i] = existing.tokens[i]! + sample.tokens[i]!
      for (let i = 0; i < BUCKETS.length; i++) existing.buckets[i] = existing.buckets[i]! + sample.buckets[i]!
    }
    if (!this.subscriptions.has(hub)) this.subscriptions.set(hub, hub.usage.observe(event => this.observe(event)))
  }

  detach(hub: ModelInfra): void {
    this.subscriptions.get(hub)?.()
    this.subscriptions.delete(hub)
  }

  private observe(event: UsageEvent): void {
    let app = this.apps.get(event.appId)
    if (!app) { app = { series: new Map(), providers: new Set() }; this.apps.set(event.appId, app) }
    const provider = identity(event.providerId, this.secrets)
    const model = identity(event.modelActual || event.modelRequested, this.secrets)
    let key = JSON.stringify([provider, model])
    let sample = app.series.get(key)
    if (!sample) {
      // ponytail: overflow retains exact totals inside the owning app, without unbounded model cardinality.
      if (app.series.size >= MAX_SERIES_PER_APP) key = "overflow"
      sample = app.series.get(key)
      if (!sample) {
        sample = key === "overflow" ? emptySample("__other__", "__other__") : emptySample(provider, model)
        app.series.set(key, sample)
      }
    }
    if (app.providers.size < MAX_SERIES_PER_APP) app.providers.add(event.providerId)
    sample.requests[event.status === "error" ? "error" : "ok"] += 1n
    const input = count(event.usage.input), output = count(event.usage.output)
    const cache = count(event.usage.cacheRead) + count(event.usage.cacheWrite)
    const cachedInput = cache > input ? input : cache
    const reasoning = count(event.usage.reasoning) > output ? output : count(event.usage.reasoning)
    const tokens = [input - cachedInput, output - reasoning, reasoning, cachedInput]
    for (let i = 0; i < tokens.length; i++) sample.tokens[i] = sample.tokens[i]! + tokens[i]!
    sample.micros += requestCostMicrosBigInt(event.cost.usd)
    const ms = typeof event.latencyMs === "number" && Number.isFinite(event.latencyMs) && event.latencyMs >= 0 ? event.latencyMs : 0
    sample.durationMs += ms
    sample.count += 1n
    for (let i = 0; i < BUCKETS.length; i++) if (ms <= BUCKETS[i]! * 1000) sample.buckets[i] = sample.buckets[i]! + 1n
  }

  render(appId: string, activeHub: ModelInfra = this.hub): string {
    const output: string[] = []
    const app = this.apps.get(appId)
    const samples = [...(app?.series.values() ?? [])]
    const currentIdentity = (value: string) => this.secrets.some(secret => value.includes(secret)) ? identity(value, this.secrets) : value
    const base = (sample: Sample) => ({ provider: currentIdentity(sample.provider), model: currentIdentity(sample.model), app_id: identity(appId, this.secrets) })
    const metadata = (name: string, help: string, type: string) => {
      output.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    }
    metadata("mik_requests_total", "Completed provider attempts since exporter start.", "counter")
    for (const sample of samples) for (const status of ["ok", "error"] as const) {
      output.push(`mik_requests_total${labels({ ...base(sample), status })} ${sample.requests[status]}`)
    }
    metadata("mik_request_duration_seconds", "Elapsed request latency at provider attempt completion in seconds.", "histogram")
    for (const sample of samples) {
      for (let i = 0; i < BUCKETS.length; i++) output.push(`mik_request_duration_seconds_bucket${labels({ ...base(sample), le: String(BUCKETS[i]) })} ${sample.buckets[i]}`)
      output.push(`mik_request_duration_seconds_bucket${labels({ ...base(sample), le: "+Inf" })} ${sample.count}`)
      output.push(`mik_request_duration_seconds_sum${labels(base(sample))} ${sample.durationMs / 1000}`)
      output.push(`mik_request_duration_seconds_count${labels(base(sample))} ${sample.count}`)
    }
    metadata("mik_tokens_total", "Token partitions; prompt excludes cache and completion excludes reasoning.", "counter")
    for (const sample of samples) for (let i = 0; i < TYPES.length; i++) {
      output.push(`mik_tokens_total${labels({ ...base(sample), type: TYPES[i]! })} ${sample.tokens[i]}`)
    }
    metadata("mik_cost_micros_total", "Cumulative integer micro-USD cost of provider attempts.", "counter")
    for (const sample of samples) output.push(`mik_cost_micros_total${labels(base(sample))} ${sample.micros}`)
    metadata("mik_provider_health_status", "Passive circuit health: CLOSED=1, OPEN or HALF_OPEN=0.", "gauge")
    const providers = new Set(app?.providers)
    if (appId === activeHub.appId) for (const provider of this.configuredProviders.get(activeHub) ?? []) providers.add(provider)
    for (const provider of providers) {
      output.push(`mik_provider_health_status${labels({ provider: identity(provider, this.secrets) })} ${activeHub.providerHealth.state(provider) === "CLOSED" ? 1 : 0}`)
    }
    return output.join("\n") + "\n"
  }

  close(): void { for (const unsubscribe of this.subscriptions.values()) unsubscribe(); this.subscriptions.clear(); this.apps.clear() }
}
