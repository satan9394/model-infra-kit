import { PROTOCOL_PACKAGES } from "../registry/presets.js"
import type { CostInfo, Protocol, ProviderConfig, TokenUsage, UsageEvent } from "../types.js"
import { redactDeep } from "../util/redact.js"
import { HttpError, type ServerContext } from "./context.js"
import { parseUsageQuery, readJsonBody, sendJson } from "./http.js"
import type { Router } from "./router.js"
import { SseStream } from "./sse.js"

function isProtocol(value: unknown): value is Protocol {
  return typeof value === "string" && Object.hasOwn(PROTOCOL_PACKAGES, value)
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `"${field}" must be an object of strings.`, "INVALID_REQUEST")
  }
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new HttpError(400, `"${field}.${key}" must be a string.`, "INVALID_REQUEST")
    output[key] = item
  }
  return output
}

/** The mutable provider fields an HTTP body may set. Unknown keys are ignored. */
function readProviderFields(body: Record<string, unknown>): Partial<ProviderConfig> {
  const fields: Partial<ProviderConfig> = {}
  if (typeof body.name === "string") fields.name = body.name
  if (typeof body.baseUrl === "string") fields.baseUrl = body.baseUrl
  if (typeof body.apiKeyRef === "string") fields.apiKeyRef = body.apiKeyRef
  if (typeof body.npmPackage === "string") fields.npmPackage = body.npmPackage
  if (typeof body.presetId === "string") fields.presetId = body.presetId
  if (typeof body.enabled === "boolean") fields.enabled = body.enabled
  if (body.protocol !== undefined) {
    if (!isProtocol(body.protocol)) {
      throw new HttpError(400, `Unsupported protocol "${String(body.protocol)}".`, "INVALID_REQUEST")
    }
    fields.protocol = body.protocol
  }
  if (body.headers !== undefined) fields.headers = stringRecord(body.headers, "headers")
  if (body.meta !== undefined) {
    if (!body.meta || typeof body.meta !== "object" || Array.isArray(body.meta)) {
      throw new HttpError(400, '"meta" must be an object.', "INVALID_REQUEST")
    }
    fields.meta = body.meta as Record<string, unknown>
  }
  return fields
}

/**
 * Provider records never hold a secret, only a reference to one, but a host can
 * put an `Authorization` header in `headers`, so every response is redacted.
 */
function sanitize<T>(value: T): T {
  return redactDeep(value)
}

function requireProvider(ctx: ServerContext, id: string): void {
  if (ctx.hub.providers.get(id)) return
  throw new HttpError(404, `Provider "${id}" is not configured.`, "PROVIDER_NOT_FOUND")
}

/** F19: one `{ events: [...] }` report carries at most this many events. */
const MAX_REPORT_EVENTS = 500

/**
 * A single reported event failed validation. Unlike `HttpError` it rejects one
 * item of a batch and leaves the rest of the report alone.
 */
class EventRejection extends Error {}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const

/** A missing cost is `missing`, exactly as an unmetered hub call is. */
const MISSING_COST = (model: string): CostInfo => ({ usd: 0, low: 0, high: 0, basis: "flat", source: "missing", pricingModel: model })

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EventRejection(`"${field}" is required and must be a non-empty string.`)
  }
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new EventRejection(`"${field}" must be a string.`)
  return value
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new EventRejection(`"${field}" must be a non-negative number.`)
  }
  return value
}

function optionalFlag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "boolean") throw new EventRejection(`"${field}" must be a boolean.`)
  return value
}

/**
 * Token counts, as `docs/SPEC.md` §4 splits them: the stored row is a total
 * (a count the host left out is 0), while the pricing view keeps the gaps so
 * `pricing.estimate()` can tell "not reported" from "reported zero" — a missing
 * `cacheWrite` must not be invented as a free cache write.
 */
function readReportedUsage(value: unknown): { usage: TokenUsage; pricing: Partial<TokenUsage> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EventRejection('"usage" is required and must be an object of non-negative integer token counts.')
  }
  const source = value as Record<string, unknown>
  const pricing: Partial<TokenUsage> = {}
  for (const field of TOKEN_FIELDS) {
    const raw = source[field]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      throw new EventRejection(`"usage.${field}" must be a non-negative integer.`)
    }
    pricing[field] = raw
  }
  return {
    usage: {
      input: pricing.input ?? 0,
      output: pricing.output ?? 0,
      cacheRead: pricing.cacheRead ?? 0,
      cacheWrite: pricing.cacheWrite ?? 0,
      reasoning: pricing.reasoning ?? 0,
    },
    pricing,
  }
}

/** `tags` values can carry a secret, so they are redacted before they are stored. */
function readReportedTags(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new EventRejection('"tags" must be an object of strings.')
  }
  const tags: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") throw new EventRejection(`"tags.${key}" must be a string.`)
    tags[key] = item
  }
  return redactDeep(tags)
}

/** A host that bills its own way reports the number; the server never re-prices it. */
function readReportedCost(value: unknown): CostInfo | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new EventRejection('"cost" must be an object with a non-negative "usd".')
  }
  const usd = (value as Record<string, unknown>).usd
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new EventRejection('"cost.usd" must be a non-negative number.')
  }
  return { usd, low: usd, high: usd, basis: "manual", source: "manual" }
}

/**
 * F19 — one event of a host-side usage report. Everything that is not a
 * validation failure is optional: a host that only knows `requestId`,
 * `providerId` and `usage` gets a priced row back.
 */
function buildReportedEvent(input: unknown, hub: ServerContext["hub"]): UsageEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EventRejection("each event must be a JSON object.")
  }
  const body = input as Record<string, unknown>

  const requestId = requiredText(body.requestId, "requestId")
  const providerId = requiredText(body.providerId, "providerId")
  const { usage, pricing } = readReportedUsage(body.usage)

  const modelRequested = optionalText(body.modelRequested, "modelRequested") ?? ""
  const modelActual = optionalText(body.modelActual, "modelActual") ?? modelRequested
  const ts = optionalNumber(body.ts, "ts") ?? Date.now()

  const status = body.status === undefined || body.status === null ? "ok" : body.status
  if (status !== "ok" && status !== "error") {
    throw new EventRejection('"status" must be "ok" or "error".')
  }

  const cost =
    readReportedCost(body.cost) ??
    (modelActual || modelRequested
      ? hub.pricing.estimate({ model: modelActual || modelRequested, at: ts, usage: pricing })
      : MISSING_COST(modelActual))

  return {
    requestId,
    appId: optionalText(body.appId, "appId") ?? hub.appId,
    ts,
    source: "report",
    providerId,
    modelRequested: modelRequested || modelActual,
    modelActual,
    pricingModel: cost.pricingModel,
    usage,
    cost,
    latencyMs: optionalNumber(body.latencyMs, "latencyMs"),
    firstTokenMs: optionalNumber(body.firstTokenMs, "firstTokenMs"),
    status,
    errorCode: optionalText(body.errorCode, "errorCode"),
    isStreaming: optionalFlag(body.isStreaming, "isStreaming", false),
    sessionId: optionalText(body.sessionId, "sessionId"),
    tags: readReportedTags(body.tags),
    pricingBasis: cost.basis,
    pricingSource: cost.source,
  }
}

export function registerApiRoutes(router: Router): void {
  router
    .add("GET", "/api/health", (ctx) => {
      const pricing = ctx.hub.pricing.state()
      sendJson(ctx.res, 200, {
        status: "ok",
        appId: ctx.hub.appId,
        baseUrl: ctx.hub.baseUrl,
        origin: ctx.origin,
        time: Date.now(),
        uptimeMs: Date.now() - ctx.startedAt,
        providers: ctx.hub.providers.list().length,
        models: ctx.hub.models.list().length,
        pricing: { status: pricing.status, source: pricing.source, loadedAt: pricing.loadedAt },
      })
    })

    .add("GET", "/api/providers", (ctx) => {
      sendJson(ctx.res, 200, { providers: sanitize(ctx.hub.providers.list()) })
    })

    .add("POST", "/api/providers", async (ctx) => {
      const body = await readJsonBody(ctx.req)
      if (typeof body.id !== "string" || !body.id.trim()) {
        throw new HttpError(400, '"id" is required.', "INVALID_REQUEST")
      }
      const record = ctx.hub.providers.add({ id: body.id.trim(), ...readProviderFields(body) })
      sendJson(ctx.res, 201, { provider: sanitize(record) })
    })

    .add("PATCH", "/api/providers/:id", async (ctx) => {
      const id = ctx.params.id!
      const existing = ctx.hub.providers.get(id)
      if (!existing) throw new HttpError(404, `Provider "${id}" is not configured.`, "PROVIDER_NOT_FOUND")
      const body = await readJsonBody(ctx.req)
      // `id` is taken from the path, never from the body: renaming would
      // silently create a second provider instead of updating this one.
      const record = ctx.hub.providers.add({ ...existing, ...readProviderFields(body), id })
      sendJson(ctx.res, 200, { provider: sanitize(record) })
    })

    .add("DELETE", "/api/providers/:id", (ctx) => {
      const id = ctx.params.id!
      if (!ctx.hub.providers.remove(id)) {
        throw new HttpError(404, `Provider "${id}" is not configured.`, "PROVIDER_NOT_FOUND")
      }
      sendJson(ctx.res, 200, { deleted: true, id })
    })

    .add("POST", "/api/providers/:id/test", async (ctx) => {
      const id = ctx.params.id!
      requireProvider(ctx, id)
      sendJson(ctx.res, 200, { status: await ctx.hub.ai.test(id) })
    })

    .add("GET", "/api/providers/:id/models", (ctx) => {
      const id = ctx.params.id!
      requireProvider(ctx, id)
      sendJson(ctx.res, 200, { models: ctx.hub.models.list(id) })
    })

    .add("POST", "/api/providers/:id/models/refresh", async (ctx) => {
      const id = ctx.params.id!
      requireProvider(ctx, id)
      // `ModelCatalog.refresh` is tapped in `events.ts`, so this also emits
      // `catalog.updated` on /api/events.
      sendJson(ctx.res, 200, { models: await ctx.hub.models.refresh(id) })
    })

    .add("GET", "/api/models", (ctx) => {
      const provider = ctx.url.searchParams.get("provider") ?? undefined
      sendJson(ctx.res, 200, { models: ctx.hub.models.list(provider) })
    })

    .add("GET", "/api/models/:ref", (ctx) => {
      const ref = ctx.params.ref!
      const model = ctx.hub.models.get(ref)
      if (!model) throw new HttpError(404, `No model matches "${ref}".`, "MODEL_NOT_FOUND")
      sendJson(ctx.res, 200, { model })
    })

    .add("GET", "/api/pricing", (ctx) => {
      sendJson(ctx.res, 200, {
        state: ctx.hub.pricing.state(),
        overrides: sanitize(ctx.hub.pricing.listOverrides()),
      })
    })

    .add("PUT", "/api/pricing/:modelId", async (ctx) => {
      const modelId = ctx.params.modelId!
      const body = await readJsonBody(ctx.req)
      const override: {
        modelId: string
        inputPerM?: number
        outputPerM?: number
        cacheReadPerM?: number
        cacheWritePerM?: number
        displayName?: string
      } = { modelId }
      for (const field of ["inputPerM", "outputPerM", "cacheReadPerM", "cacheWritePerM"] as const) {
        const value = body[field]
        if (value === undefined || value === null) continue
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new HttpError(400, `"${field}" must be a non-negative number.`, "INVALID_REQUEST")
        }
        override[field] = value
      }
      if (typeof body.displayName === "string") override.displayName = body.displayName
      // S3: a manual price needs at least one rate; `setOverride` enforces it.
      ctx.hub.pricing.setOverride(override)
      sendJson(ctx.res, 200, {
        override: ctx.hub.pricing.listOverrides().find((item) => item.modelId === modelId) ?? null,
      })
    })

    .add("DELETE", "/api/pricing/:modelId", (ctx) => {
      const modelId = ctx.params.modelId!
      if (!ctx.hub.pricing.removeOverride(modelId)) {
        throw new HttpError(404, `No manual price is set for "${modelId}".`, "MODEL_NOT_FOUND")
      }
      sendJson(ctx.res, 200, { removed: true, modelId })
    })

    .add("POST", "/api/pricing/sync", async (ctx) => {
      sendJson(ctx.res, 200, { state: await ctx.hub.pricing.refresh() })
    })

    .add("GET", "/api/usage/summary", (ctx) => {
      sendJson(ctx.res, 200, { summary: ctx.hub.usage.summary(parseUsageQuery(ctx.url)) })
    })

    .add("GET", "/api/usage/trends", (ctx) => {
      const raw = ctx.url.searchParams.get("bucket")
      if (raw !== null && raw !== "day" && raw !== "hour") {
        throw new HttpError(400, '"bucket" must be "day" or "hour".', "INVALID_REQUEST")
      }
      const bucket = raw === "hour" ? "hour" : "day"
      sendJson(ctx.res, 200, { bucket, points: ctx.hub.usage.trends(parseUsageQuery(ctx.url), bucket) })
    })

    .add("GET", "/api/usage/by-provider", (ctx) => {
      sendJson(ctx.res, 200, { buckets: ctx.hub.usage.byProvider(parseUsageQuery(ctx.url)) })
    })

    .add("GET", "/api/usage/by-model", (ctx) => {
      sendJson(ctx.res, 200, { buckets: ctx.hub.usage.byModel(parseUsageQuery(ctx.url)) })
    })

    .add("GET", "/api/usage/logs", (ctx) => {
      const query = parseUsageQuery(ctx.url)
      const page = ctx.hub.usage.query(query)
      sendJson(ctx.res, 200, {
        total: page.total,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
        events: sanitize(page.events),
      })
    })

    .add("GET", "/api/usage/logs/:id", (ctx) => {
      const id = ctx.params.id!
      // App-scoped by default (B1): an id belonging to another app reads as absent.
      const event = ctx.hub.usage.get(id)
      if (!event) throw new HttpError(404, `No usage event with request id "${id}".`, "NOT_FOUND")
      sendJson(ctx.res, 200, { event: sanitize(event) })
    })

    .add("POST", "/api/usage/events", async (ctx) => {
      const body = await readJsonBody(ctx.req)
      // A single event and a batch are the same code path: the body *is* the
      // one-element report when it has no `events` key.
      const raw = body.events === undefined ? [body] : body.events
      if (!Array.isArray(raw)) {
        throw new HttpError(400, '"events" must be an array of usage events.', "INVALID_REQUEST")
      }
      if (raw.length > MAX_REPORT_EVENTS) {
        throw new HttpError(
          400,
          `A usage report carries at most ${MAX_REPORT_EVENTS} events; received ${raw.length}.`,
          "INVALID_REQUEST",
        )
      }
      // With metering off, `record()` always answers "not stored", which would
      // be reported as a duplicate. Refuse the report instead of lying.
      if (!ctx.hub.usage.isEnabled) {
        throw new HttpError(503, "Usage metering is disabled on this server.", "STORAGE")
      }

      let accepted = 0
      let duplicates = 0
      const rejected: Array<{ index: number; reason: string }> = []

      for (const [index, item] of raw.entries()) {
        let event: UsageEvent
        try {
          event = buildReportedEvent(item, ctx.hub)
        } catch (error) {
          // One bad item never costs the rest of the batch its row.
          rejected.push({ index, reason: error instanceof EventRejection ? error.message : "the event could not be read." })
          continue
        }
        // Idempotent per `requestId`: a duplicate is counted, never rewritten.
        if (ctx.hub.usage.record(event)) accepted += 1
        else duplicates += 1
      }

      sendJson(ctx.res, 200, { accepted, duplicates, rejected })
    })

    .add("GET", "/api/events", (ctx) => {
      const stream = new SseStream(ctx.res, ctx.heartbeatMs)
      ctx.trackSse(stream)
      stream.open()
      stream.startHeartbeat()
      const unsubscribe = ctx.bus.subscribe((event) => {
        void stream.send(event.type, event.data)
      })
      // Both listeners fire on a client disconnect; `close()` is idempotent.
      stream.onClose(() => {
        unsubscribe()
        stream.close()
      })
    })
}
