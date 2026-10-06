/**
 * The OpenAPI 3.1 description of this server, built once per request so the
 * `servers` entry and the security scheme reflect the actual handle.
 */

interface OpenApiOptions {
  /** The URL this server is published under, e.g. `http://127.0.0.1:3211`. */
  origin: string
  /** True when a bearer token is required. */
  secured: boolean
}

type Schema = Record<string, unknown>

function ref(name: string): Schema {
  return { $ref: `#/components/schemas/${name}` }
}

function param(name: string, schema: Schema, description?: string): Schema {
  return { name, in: "query", required: false, ...(description ? { description } : {}), schema }
}

function body(schema: Schema, required = true): Schema {
  return { required, content: { "application/json": { schema } } }
}

function ok(description: string, schema?: Schema): Schema {
  return schema ? { description, content: { "application/json": { schema } } } : { description }
}

function error(description: string): Schema {
  return ok(description, ref("Error"))
}

const TIME_PARAM = { type: "string", description: "ISO-8601 timestamp or epoch milliseconds." }

/** The query parameters every `/api` collection endpoint shares. */
const USAGE_PARAMS: Schema[] = [
  param("from", TIME_PARAM, "Inclusive lower bound on the event timestamp."),
  param("to", TIME_PARAM, "Exclusive upper bound on the event timestamp."),
  param("provider", { type: "string" }, "Filter by provider id."),
  param("model", { type: "string" }, "Filter by the model id the provider actually served."),
  param("status", { type: "string", enum: ["ok", "error"] }),
  param("sessionId", { type: "string" }),
  param("limit", { type: "integer", minimum: 1, maximum: 1000, default: 50 }),
  param("offset", { type: "integer", minimum: 0, default: 0 }),
]

function schemas(): Record<string, Schema> {
  return {
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["message", "type", "code"],
          properties: {
            message: { type: "string" },
            type: { type: "string", enum: ["invalid_request_error", "server_error"] },
            code: { type: "string" },
          },
        },
      },
    },
    Health: {
      type: "object",
      properties: {
        status: { type: "string" },
        service: { type: "string", const: "model-infra-kit" },
        appId: { type: "string" },
        baseUrl: { type: "string" },
        origin: { type: "string" },
        time: { type: "integer" },
        uptimeMs: { type: "integer" },
        providers: { type: "integer" },
        models: { type: "integer" },
        pricing: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["fresh", "stale", "error"] },
            source: { type: "string" },
            loadedAt: { type: "integer" },
          },
        },
      },
    },
    TokenUsage: {
      type: "object",
      properties: {
        input: { type: "integer" },
        output: { type: "integer" },
        cacheRead: { type: "integer" },
        cacheWrite: { type: "integer" },
        reasoning: { type: "integer" },
      },
    },
    CostInfo: {
      type: "object",
      properties: {
        usd: { type: "number" },
        low: { type: "number" },
        high: { type: "number" },
        basis: { type: "string" },
        source: { type: "string" },
        pricingModel: { type: "string" },
        providerId: { type: "string" },
      },
    },
    ModelCapabilities: {
      type: "object",
      properties: {
        text: { type: "boolean" },
        image: { type: "boolean" },
        toolCall: { type: "boolean" },
        reasoning: { type: "boolean" },
        structuredOutput: { type: "boolean" },
      },
    },
    ModelInfo: {
      type: "object",
      properties: {
        providerId: { type: "string" },
        modelId: { type: "string" },
        ref: { type: "string", description: "`provider:model`" },
        displayName: { type: "string" },
        contextWindow: { type: "integer" },
        maxOutputTokens: { type: "integer" },
        capabilities: ref("ModelCapabilities"),
        pricing: ref("ModelPricing"),
        source: { type: "string", enum: ["provider_api", "models_dev", "preset", "manual"] },
        syncedAt: { type: "integer" },
      },
    },
    CatalogModelCapabilities: {
      type: "object",
      required: ["reasoning", "vision", "tools", "structuredOutputs"],
      properties: {
        reasoning: { type: "boolean" },
        reasoningEffortLevels: {
          type: "array",
          items: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max"] },
        },
        vision: { type: "boolean" },
        audio: { type: "boolean" },
        tools: { type: "boolean" },
        structuredOutputs: { type: "boolean" },
      },
    },
    ModelMetadata: {
      type: "object",
      required: ["id", "family", "name", "contextWindow", "capabilities", "source", "sourceUrl"],
      properties: {
        id: { type: "string" },
        family: { type: "string" },
        name: { type: "string" },
        contextWindow: { type: "integer" },
        maxOutputTokens: { type: "integer" },
        knowledgeCutoff: { type: "string" },
        capabilities: ref("CatalogModelCapabilities"),
        source: { type: "string" },
        sourceUrl: { type: "string", format: "uri" },
        sourceProviderId: { type: "string" },
      },
    },
    ProviderModelBinding: {
      type: "object",
      required: ["providerId", "protocol", "modelId", "upstreamModelName", "status"],
      properties: {
        providerId: { type: "string" },
        protocol: { type: "string", enum: ["openai-compatible", "openai", "anthropic", "google", "deepseek", "moonshotai", "xai"] },
        modelId: { type: "string" },
        upstreamModelName: { type: "string" },
        status: { type: "string", enum: ["available", "deprecated", "preview"] },
      },
    },
    ModelPricing: {
      type: "object",
      properties: {
        inputPerM: { type: "number" },
        outputPerM: { type: "number" },
        cacheReadPerM: { type: "number" },
        cacheWritePerM: { type: "number" },
        currency: { type: "string", enum: ["USD"] },
        source: { type: "string" },
        displayName: { type: "string" },
        providerId: { type: "string" },
        contextTierAbove: { type: "integer" },
        reasoningMode: { type: "boolean" },
      },
    },
    Provider: {
      type: "object",
      properties: {
        id: { type: "string" },
        appId: { type: "string" },
        name: { type: "string" },
        protocol: { type: "string" },
        baseUrl: { type: "string" },
        apiKeyRef: {
          description: "Credential references only; secrets are never stored.",
          anyOf: [
            { type: "string", description: "A single reference or comma-separated references." },
            { type: "array", items: { type: "string" } },
          ],
        },
        npmPackage: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        enabled: { type: "boolean" },
        presetId: { type: "string" },
        meta: { type: "object" },
        createdAt: { type: "integer" },
        updatedAt: { type: "integer" },
      },
    },
    ProviderInput: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
        name: { type: "string" },
        protocol: { type: "string" },
        baseUrl: { type: "string" },
        apiKeyRef: {
          description: "Credential references only; secrets are never stored.",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        npmPackage: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        enabled: { type: "boolean" },
        presetId: { type: "string" },
        meta: { type: "object" },
      },
    },
    ProviderStatus: {
      type: "object",
      properties: {
        providerId: { type: "string" },
        ok: { type: "boolean" },
        message: { type: "string" },
        modelCount: { type: "integer" },
        latencyMs: { type: "integer" },
        checkedAt: { type: "integer" },
      },
    },
    PricingOverride: {
      type: "object",
      properties: {
        modelId: { type: "string" },
        displayName: { type: "string" },
        inputPerM: { type: "number" },
        outputPerM: { type: "number" },
        cacheReadPerM: { type: "number" },
        cacheWritePerM: { type: "number" },
        updatedAt: { type: "integer" },
      },
    },
    PricingState: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["fresh", "stale", "error"] },
        loadedAt: { type: "integer" },
        source: { type: "string" },
        lastError: { type: "string" },
      },
    },
    BudgetConfig: {
      type: "object",
      properties: {
        usd: { type: "number", exclusiveMinimum: 0, description: "Legacy single-window USD limit." },
        window: { type: "string", enum: ["day", "month"], default: "day" },
        onExceed: { type: "string", enum: ["warn"], default: "warn" },
        dailyMicros: { type: "integer", minimum: 1, description: "UTC daily limit in integer micro-USD." },
        monthlyMicros: { type: "integer", minimum: 1, description: "UTC calendar-month limit in integer micro-USD." },
        currency: { type: "string", enum: ["USD"], default: "USD" },
      },
      description: "Advisory limits only. Crossing a limit never blocks or rejects a request.",
    },
    BudgetPeriod: {
      type: "object",
      required: [
        "spentMicros",
        "limitMicros",
        "remainingMicros",
        "overageMicros",
        "percent",
        "status",
        "from",
        "to",
        "unpricedRequests",
        "archivedRequests",
        "historicalAllocationLimited",
      ],
      properties: {
        spentMicros: { type: "integer", minimum: 0, description: "Actual spend in integer micro-USD." },
        limitMicros: { type: "integer", minimum: 1, description: "Configured limit in integer micro-USD." },
        remainingMicros: { type: "integer", minimum: 0, description: "Unspent amount; zero after the limit is reached." },
        overageMicros: { type: "integer", minimum: 0, description: "Amount above the limit; zero while within budget." },
        percent: { type: "integer", minimum: 0, description: "Whole percentage points, floored with integer arithmetic." },
        status: { type: "string", enum: ["ok", "warning", "exceeded"] },
        from: { type: "integer", description: "Inclusive UTC range start in epoch milliseconds." },
        to: { type: "integer", description: "Exclusive UTC range end in epoch milliseconds." },
        unpricedRequests: { type: "integer", minimum: 0 },
        archivedRequests: { type: "integer", minimum: 0 },
        historicalAllocationLimited: {
          type: "boolean",
          description: "True when retained local-date rollups are included in a UTC range and allocation is approximate.",
        },
      },
    },
    BudgetStatus: {
      type: "object",
      required: ["currency", "advisory", "daily", "monthly"],
      properties: {
        currency: { type: "string", enum: ["USD"] },
        advisory: { type: "boolean", const: true, description: "Always true; budget status never blocks requests." },
        daily: { anyOf: [ref("BudgetPeriod"), { type: "null" }] },
        monthly: { anyOf: [ref("BudgetPeriod"), { type: "null" }] },
      },
    },
    UsageSummary: {
      type: "object",
      properties: {
        requests: { type: "integer" },
        successes: { type: "integer" },
        failures: { type: "integer" },
        successRate: { type: "number" },
        costUsd: { type: "number" },
        costLowUsd: { type: "number" },
        costHighUsd: { type: "number" },
        tokens: ref("TokenUsage"),
        cacheHitRate: { type: "number" },
        // EVO-G82 (audit R232 F3): `null` here means **nothing in the range
        // recorded one**, which is not the same as `0`. Letting these be plain
        // `number` is what let a client (and the CLI) print `0 ms` for a
        // measurement that never happened. Serialized as `null`, matching the
        // JSON body (`JSON.stringify` drops the `undefined` either way).
        avgLatencyMs: {
          type: ["number", "null"],
          description:
            "Mean latency over the events that recorded one; `null` when none did (never `0` — a missing measurement is not an instant answer).",
        },
        firstTokenMs: {
          type: ["number", "null"],
          description:
            "Mean time to first token over the events that recorded one; `null` when none did. The denominator is only those events, so this is not comparable across ranges with different streaming coverage.",
        },
        // EVO-G78: the three cost fields above sum only what was **recorded**, so
        // an unpriced request adds 0 and does not widen the interval. These mark
        // that: `costLowerBoundOnly` says to read the cost as a floor, and the
        // two counters name what is missing. Additive; no number changed.
        costLowerBoundOnly: {
          type: "boolean",
          description:
            'True when `costUsd`/`costLowUsd`/`costHighUsd` must be read as a floor ("at least this much"), because part of the range has no knowable price: `unpricedRequests` and/or `unmeasuredRequests` is non-zero. A client that ignores this flag reads an unknown amount as an exact one — those three fields sum only what was recorded, and an unpriced request contributes 0. No amount is ever interpolated or estimated, and when this is false the cost is the exact recorded total.',
        },
        unpricedRequests: {
          type: "integer",
          description:
            "Requests in this range whose price could not be resolved at all (missing `pricing_source`); each is recorded at 0 and adds 0 to every cost field. Detail rows only — a folded day is counted by `unmeasuredRequests` instead.",
        },
        unmeasuredRequests: {
          type: "integer",
          description:
            "Requests already folded into `usage_daily_rollups`, whose `pricing_source` is no longer stored, so whether they were priced is unknowable. Counted so the gap is visible; never guessed at.",
        },
      },
    },
    UsageTrendPoint: {
      type: "object",
      required: ["costLowUsd", "costHighUsd"],
      properties: {
        date: { type: "string" },
        requests: { type: "integer" },
        costUsd: { type: "number" },
        costLowUsd: { type: "number", description: "Recorded lower endpoint, aggregated as integer micro-USD." },
        costHighUsd: { type: "number", description: "Recorded upper endpoint, aggregated as integer micro-USD." },
        tokens: ref("TokenUsage"),
      },
    },
    UsageBucket: {
      type: "object",
      required: ["costLowUsd", "costHighUsd"],
      properties: {
        key: { type: "string" },
        requests: { type: "integer" },
        costUsd: { type: "number" },
        costLowUsd: { type: "number", description: "Recorded lower endpoint, aggregated as integer micro-USD." },
        costHighUsd: { type: "number", description: "Recorded upper endpoint, aggregated as integer micro-USD." },
        tokens: ref("TokenUsage"),
      },
    },
    UsageTraceGroup: {
      type: "object",
      required: [
        "id", "groupBy", "requests", "successes", "failures", "costLowUsd", "costHighUsd",
        "tokens", "startedAt", "endedAt", "durationMs", "archivedRequests",
      ],
      properties: {
        id: { type: "string" },
        groupBy: { type: "string", enum: ["session", "trace"] },
        sessionId: { type: "string" },
        traceId: { type: "string" },
        requests: { type: "integer" },
        successes: { type: "integer" },
        failures: { type: "integer" },
        costLowUsd: { type: "number", description: "Recorded lower endpoint, aggregated as integer micro-USD." },
        costHighUsd: { type: "number", description: "Recorded upper endpoint, aggregated as integer micro-USD." },
        tokens: ref("TokenUsage"),
        startedAt: { type: "integer" },
        endedAt: { type: "integer" },
        durationMs: { type: "integer" },
        avgLatencyMs: { type: "number" },
        avgFirstTokenMs: { type: "number" },
        archivedRequests: { type: "integer", description: "Requests retained as daily aggregates without individual detail rows." },
      },
    },
    UsageEvent: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        appId: { type: "string" },
        ts: { type: "integer" },
        source: { type: "string", description: "`generate`, `stream`, `fetch` or `report`." },
        providerId: { type: "string" },
        modelRequested: { type: "string" },
        modelActual: { type: "string" },
        pricingModel: { type: "string" },
        usage: ref("TokenUsage"),
        cost: ref("CostInfo"),
        latencyMs: { type: "integer" },
        firstTokenMs: { type: "integer" },
        status: { type: "string", enum: ["ok", "error"] },
        errorCode: { type: "string" },
        isStreaming: { type: "boolean" },
        traceId: { type: "string" },
        sessionId: { type: "string" },
        tags: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    UsageEventInput: {
      type: "object",
      required: ["requestId", "providerId", "usage"],
      properties: {
        requestId: { type: "string", description: "Idempotency key: a duplicate is counted, never overwritten." },
        ts: { type: "integer", description: "Epoch milliseconds; defaults to the server clock." },
        providerId: { type: "string" },
        modelRequested: { type: "string" },
        modelActual: { type: "string", description: "The model the price is estimated from when `cost` is absent." },
        usage: {
          type: "object",
          description: "Non-negative integer token counts. A missing count is stored as 0.",
          properties: {
            input: { type: "integer", minimum: 0 },
            output: { type: "integer", minimum: 0 },
            cacheRead: { type: "integer", minimum: 0 },
            cacheWrite: { type: "integer", minimum: 0 },
            reasoning: { type: "integer", minimum: 0 },
          },
        },
        cost: {
          type: "object",
          description: "The host's own figure. Omitted, the server prices the event itself.",
          properties: { usd: { type: "number", minimum: 0 } },
        },
        latencyMs: { type: "integer", minimum: 0 },
        firstTokenMs: { type: "integer", minimum: 0 },
        status: { type: "string", enum: ["ok", "error"], default: "ok" },
        errorCode: { type: "string" },
        isStreaming: { type: "boolean" },
        traceId: { type: "string" },
        sessionId: { type: "string" },
        appId: { type: "string", description: "Defaults to the server's app id." },
        tags: { type: "object", additionalProperties: { type: "string" }, description: "Values are redacted before storage." },
      },
    },
    UsageEventReport: {
      type: "object",
      required: ["accepted", "duplicates", "rejected"],
      properties: {
        accepted: { type: "integer" },
        duplicates: { type: "integer" },
        rejected: {
          type: "array",
          items: {
            type: "object",
            required: ["index", "reason"],
            properties: { index: { type: "integer" }, reason: { type: "string" } },
          },
        },
      },
    },
    ChatMessage: {
      type: "object",
      required: ["role"],
      properties: {
        role: { type: "string", enum: ["system", "user", "assistant", "tool", "developer"] },
        content: { description: "A string or an array of content parts, as in the OpenAI API." },
        name: { type: "string" },
        tool_call_id: { type: "string" },
        tool_calls: { type: "array", items: { type: "object" } },
      },
    },
    ChatCompletionRequest: {
      type: "object",
      required: ["messages"],
      properties: {
        model: { type: "string", description: "`provider:model`, or a bare model id plus X-ModelHub-Provider." },
        messages: { type: "array", minItems: 1, items: ref("ChatMessage") },
        stream: { type: "boolean", default: false },
        temperature: { type: "number" },
        max_tokens: { type: "integer" },
        max_completion_tokens: { type: "integer" },
        user: { type: "string", description: "Recorded as the usage event's sessionId." },
        session_id: { type: "string", description: "Alternative session attribution; `X-Mik-Session-Id` is also accepted." },
        trace_id: { type: "string", description: "Agent trace attribution; `X-Mik-Trace-Id` is also accepted." },
        metadata: { type: "object", additionalProperties: { type: "string" }, description: "`metadata.trace_id`, when present, is recorded as the Agent trace id." },
        fallback_chain: { type: "array", items: { type: "string" }, description: "Ordered provider:model references used after retryable failures." },
        reasoning_timeout_ms: { type: "integer", minimum: 1, description: "First-output timeout for streams; also a call timeout for non-stream requests." },
      },
    },
    ChatCompletionResponse: {
      type: "object",
      properties: {
        id: { type: "string" },
        object: { type: "string", enum: ["chat.completion"] },
        created: { type: "integer" },
        model: { type: "string" },
        choices: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              message: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  content: { type: ["string", "null"] },
                  tool_calls: { type: "array", items: { type: "object" } },
                },
              },
              finish_reason: { type: "string" },
              logprobs: { type: ["object", "null"] },
            },
          },
        },
        usage: {
          type: "object",
          properties: {
            prompt_tokens: { type: "integer" },
            completion_tokens: { type: "integer" },
            total_tokens: { type: "integer" },
            prompt_tokens_details: {
              type: "object",
              properties: { cached_tokens: { type: "integer" } },
            },
            completion_tokens_details: {
              type: "object",
              properties: { reasoning_tokens: { type: "integer" } },
            },
          },
        },
        x_modelhub: {
          type: "object",
          description: "Additive: the metered cost and latency of this call.",
          properties: {
            provider: { type: "string" },
            model_requested: { type: "string" },
            cost_usd: { type: "number" },
            cost_source: { type: "string" },
            latency_ms: { type: "integer" },
            first_token_ms: { type: ["integer", "null"] },
            steps: { type: "integer" },
          },
        },
      },
    },
    ModelList: {
      type: "object",
      properties: {
        object: { type: "string", enum: ["list"] },
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "`provider:model`" },
              object: { type: "string", enum: ["model"] },
              created: { type: "integer" },
              owned_by: { type: "string" },
            },
          },
        },
      },
    },
    SseEvent: {
      type: "object",
      description: "`event:` is the topic; `data:` is this JSON frame.",
      properties: {
        type: { type: "string", enum: ["usage.recorded", "catalog.updated", "pricing.updated"] },
        at: { type: "integer" },
        data: { description: "The UsageEvent, or `{ providerId, models }` / `{ action, modelId }`." },
      },
    },
  }
}

export function buildOpenApiDocument(options: OpenApiOptions): Record<string, unknown> {
  const security = options.secured ? [{ bearerAuth: [] }] : []

  const document: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: "model-infra-kit HTTP API",
      version: "0.1.0",
      description:
        "OpenAI-compatible endpoint plus the metering REST API. `provider:model` references are accepted wherever a model is named.",
      license: { name: "MIT" },
    },
    servers: [{ url: options.origin }],
    tags: [
      { name: "health" },
      { name: "providers" },
      { name: "models" },
      { name: "pricing" },
      { name: "budget" },
      { name: "usage" },
      { name: "events" },
      { name: "openai" },
    ],
    paths: {
      "/api/health": {
        get: {
          tags: ["health"],
          summary: "Liveness probe. The only endpoint exempt from bearer auth.",
          security: [],
          responses: { "200": ok("The server is up.", ref("Health")) },
        },
      },
      "/api/budget/status": {
        get: {
          tags: ["budget"],
          summary: "Read advisory daily and monthly spend status.",
          responses: {
            "200": ok("The current integer-micro-USD budget status.", ref("BudgetStatus")),
          },
        },
      },
      "/api/providers": {
        get: {
          tags: ["providers"],
          summary: "List configured providers.",
          responses: { "200": ok("The provider records.", { type: "object", properties: { providers: { type: "array", items: ref("Provider") } } }) },
        },
        post: {
          tags: ["providers"],
          summary: "Add or replace a provider.",
          requestBody: body(ref("ProviderInput")),
          responses: {
            "201": ok("The stored record.", { type: "object", properties: { provider: ref("Provider") } }),
            "400": error("The provider configuration is invalid."),
          },
        },
      },
      "/api/providers/probe": {
        post: {
          tags: ["providers"],
          summary: "Discover models from temporary configuration without saving it (5 second deadline).",
          requestBody: body({ type: "object", required: ["protocol"], properties: {
            baseUrl: { type: "string" }, apiKeyRef: { type: "string" },
            protocol: { type: "string", enum: ["openai-compatible", "openai", "anthropic", "google", "deepseek", "moonshotai", "xai"] },
          } }),
          responses: {
            "200": ok("Redacted one-shot result; upstream failures set status.ok=false.", { type: "object", properties: {
              status: { allOf: [ref("ProviderStatus"), { type: "object", properties: { errorCode: { type: "string" } } }] },
              baseUrl: { type: "string", description: "Normalized successful base URL, suitable for saving." },
              models: { type: "array", items: { type: "object", required: ["modelId"], properties: {
                modelId: { type: "string" }, displayName: { type: "string" }, contextWindow: { type: "integer" },
                maxOutputTokens: { type: "integer" }, capabilities: ref("ModelCapabilities"),
              } } },
            } }),
            "400": error("Invalid configuration or unsafe outbound URL."),
          },
        },
      },
      "/api/providers/{id}": {
        patch: {
          tags: ["providers"],
          summary: "Update the given fields of a provider.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: body(ref("ProviderInput"), false),
          responses: {
            "200": ok("The stored record.", { type: "object", properties: { provider: ref("Provider") } }),
            "404": error("No such provider."),
          },
        },
        delete: {
          tags: ["providers"],
          summary: "Remove a provider.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": ok("Removed.", { type: "object", properties: { deleted: { type: "boolean" }, id: { type: "string" } } }),
            "404": error("No such provider."),
          },
        },
      },
      "/api/providers/{id}/test": {
        post: {
          tags: ["providers"],
          summary: "Check connectivity and credentials.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": ok("The probe result.", { type: "object", properties: { status: ref("ProviderStatus") } }),
            "404": error("No such provider."),
          },
        },
      },
      "/api/providers/{id}/models": {
        get: {
          tags: ["models"],
          summary: "The stored catalogue of one provider.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": ok("The models.", { type: "object", properties: { models: { type: "array", items: ref("ModelInfo") } } }),
            "404": error("No such provider."),
          },
        },
      },
      "/api/providers/{id}/models/refresh": {
        post: {
          tags: ["models"],
          summary: "Re-discover the catalogue of one provider. Emits `catalog.updated`.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": ok("The refreshed models.", { type: "object", properties: { models: { type: "array", items: ref("ModelInfo") } } }),
            "404": error("No such provider."),
          },
        },
      },
      "/api/models": {
        get: {
          tags: ["models"],
          summary: "The whole catalogue.",
          parameters: [param("provider", { type: "string" }, "Restrict to one provider.")],
          responses: { "200": ok("The models.", { type: "object", properties: { models: { type: "array", items: ref("ModelInfo") }, defaultModel: { type: ["string", "null"] } } }) },
        },
      },
      "/api/catalog": {
        get: {
          tags: ["models"],
          summary: "Canonical model facts and provider endpoint bindings from the bundled snapshot.",
          responses: {
            "200": ok("The static model catalog.", {
              type: "object",
              required: ["source", "models", "bindings"],
              properties: {
                source: { type: "string" },
                models: { type: "array", items: ref("ModelMetadata") },
                bindings: { type: "array", items: ref("ProviderModelBinding") },
              },
            }),
          },
        },
      },
      "/api/models/{ref}": {
        get: {
          tags: ["models"],
          summary: "One model by `provider:model` reference.",
          parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": ok("The model.", { type: "object", properties: { model: ref("ModelInfo") } }),
            "404": error("No such model."),
          },
        },
      },
      "/api/models/{ref}/default": {
        put: {
          tags: ["models"],
          summary: "Persist the host default discovered model.",
          parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Default saved.", { type: "object", properties: { defaultModel: { type: "string" } } }), "404": error("No such model.") },
        },
      },
      "/api/models/{ref}/ping": {
        post: {
          tags: ["models"],
          summary: "Stream one tiny billed ping (4 output tokens maximum), without fallback. DNS is a separate OS preflight lookup.",
          parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Measured result.", { type: "object", properties: {
            ref: { type: "string" }, prompt: { type: "string" }, maxOutputTokens: { type: "integer" },
            latencyMs: { type: "number" }, firstTokenMs: { type: ["number", "null"] }, dnsMs: { type: ["number", "null"] }, dnsNote: { type: "string" },
            outputTokens: { type: "integer" }, reasoningTokens: { type: "integer" }, tokensPerSecond: { type: ["number", "null"] }, text: { type: "string" },
          } }), "404": error("No such model."), "504": error("Ping timed out.") },
        },
      },
      "/api/pricing": {
        get: {
          tags: ["pricing"],
          summary: "Catalogue state and manual prices.",
          responses: {
            "200": ok("The pricing state.", {
              type: "object",
              properties: { state: ref("PricingState"), overrides: { type: "array", items: ref("PricingOverride") } },
            }),
          },
        },
      },
      "/api/pricing/{modelId}": {
        put: {
          tags: ["pricing"],
          summary: "Set a manual price. At least one rate is required. Emits `pricing.updated`.",
          parameters: [{ name: "modelId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: body({
            type: "object",
            properties: {
              inputPerM: { type: "number", minimum: 0 },
              outputPerM: { type: "number", minimum: 0 },
              cacheReadPerM: { type: "number", minimum: 0 },
              cacheWritePerM: { type: "number", minimum: 0 },
              displayName: { type: "string" },
            },
          }),
          responses: {
            "200": ok("The stored override.", { type: "object", properties: { override: ref("PricingOverride") } }),
            "400": error("No rate was supplied."),
          },
        },
        delete: {
          tags: ["pricing"],
          summary: "Remove a manual price.",
          parameters: [{ name: "modelId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": ok("Removed.", { type: "object", properties: { removed: { type: "boolean" }, modelId: { type: "string" } } }),
            "404": error("No manual price for that model."),
          },
        },
      },
      "/api/pricing/sync": {
        post: {
          tags: ["pricing"],
          summary: "Reload the upstream price catalogue. Emits `pricing.updated`.",
          responses: { "200": ok("The new state.", { type: "object", properties: { state: ref("PricingState") } }) },
        },
      },
      "/api/usage/summary": {
        get: {
          tags: ["usage"],
          summary: "Aggregate totals.",
          parameters: USAGE_PARAMS,
          responses: { "200": ok("The totals.", { type: "object", properties: { summary: ref("UsageSummary") } }) },
        },
      },
      "/api/usage/trends": {
        get: {
          tags: ["usage"],
          summary: "Requests, cost and tokens per day or hour.",
          parameters: [...USAGE_PARAMS, param("bucket", { type: "string", enum: ["day", "hour"], default: "day" })],
          responses: {
            "200": ok("The series.", {
              type: "object",
              properties: {
                bucket: { type: "string" },
                points: { type: "array", items: ref("UsageTrendPoint") },
              },
            }),
          },
        },
      },
      "/api/usage/by-provider": {
        get: {
          tags: ["usage"],
          summary: "Totals grouped by provider.",
          parameters: USAGE_PARAMS,
          responses: { "200": ok("The buckets.", { type: "object", properties: { buckets: { type: "array", items: ref("UsageBucket") } } }) },
        },
      },
      "/api/usage/by-model": {
        get: {
          tags: ["usage"],
          summary: "Totals grouped by model.",
          parameters: USAGE_PARAMS,
          responses: { "200": ok("The buckets.", { type: "object", properties: { buckets: { type: "array", items: ref("UsageBucket") } } }) },
        },
      },
      "/api/usage/search": {
        get: {
          tags: ["usage"],
          summary: "Search redacted retained trace metadata using FTS5 MATCH, ordered by BM25 relevance.",
          parameters: [...USAGE_PARAMS, param("traceId", { type: "string" }), param("q", { type: "string", maxLength: 4096 }, "FTS5 MATCH expression; quote punctuation.")],
          responses: {
            "200": ok("At most 1000 matching retained events. Raw prompts and tool results are not stored.", {
              type: "object", properties: { hits: { type: "array", items: {
                type: "object", properties: { event: ref("UsageEvent"), score: { type: "number" },
                  snippet: { type: "string", description: "Plain text with U+0001/U+0002 match markers; never HTML." } },
              } } },
            }),
            "400": error("Invalid MATCH expression, query length or pagination; FTS5 unavailable."),
          },
        },
      },
      "/api/usage/logs": {
        get: {
          tags: ["usage"],
          summary: "Request detail, newest first.",
          parameters: [...USAGE_PARAMS, param("traceId", { type: "string" })],
          responses: {
            "200": ok("One page of events.", {
              type: "object",
              properties: {
                total: { type: "integer" },
                limit: { type: "integer" },
                offset: { type: "integer" },
                events: { type: "array", items: ref("UsageEvent") },
              },
            }),
          },
        },
      },
      "/api/usage/traces": {
        get: {
          tags: ["usage"],
          summary: "Agent activity aggregated by session or trace, with integer-micro-USD cost totals.",
          parameters: [
            ...USAGE_PARAMS,
            param("traceId", { type: "string" }, "Filter to one trace; useful when viewing a session containing multiple traces."),
            param("groupBy", { type: "string", enum: ["trace", "session"], default: "trace" }),
          ],
          responses: {
            "200": ok("Session or trace aggregates.", {
              type: "object",
              required: ["groupBy", "groups"],
              properties: {
                groupBy: { type: "string", enum: ["trace", "session"] },
                groups: { type: "array", items: ref("UsageTraceGroup") },
              },
            }),
            "400": error('"groupBy" must be "trace" or "session."'),
          },
        },
      },
      "/api/usage/logs/{id}": {
        get: {
          tags: ["usage"],
          summary: "One request by request id, scoped to this app.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": ok("The event.", { type: "object", properties: { event: ref("UsageEvent") } }),
            "404": error("No such event for this app."),
          },
        },
      },
      "/api/usage/events": {
        post: {
          tags: ["usage"],
          summary: "Report usage the host metered itself. One event, or `{ events: [...] }` of at most 500.",
          requestBody: body({
            oneOf: [
              ref("UsageEventInput"),
              {
                type: "object",
                required: ["events"],
                properties: { events: { type: "array", maxItems: 500, items: ref("UsageEventInput") } },
              },
            ],
          }),
          responses: {
            "200": ok("How many events were stored, deduplicated or rejected.", ref("UsageEventReport")),
            "400": error("The report is malformed or carries more than 500 events."),
            "401": error("The bearer token is missing or wrong."),
            "503": error("Usage metering is disabled on this server."),
          },
        },
      },
      "/api/reload": {
        post: {
          tags: ["health"],
          summary: "Reload the configured file atomically; requires admin.",
          responses: { "200": ok("New requests use the prepared generation; existing streams drain naturally.", {
            type: "object", properties: { reloaded: { type: "boolean" }, swapMicros: { type: "number" } },
          }), "400": error("Invalid configuration; the old generation is retained."),
          "401": error("Missing or invalid token."), "403": error("Insufficient scope."), "409": error("File reload is not enabled.") },
        },
      },
      "/api/connections": {
        get: {
          tags: ["events"],
          summary: "App-scoped active chat requests and event streams; requires read:usage.",
          responses: { "200": ok("Process-local connection metadata, no prompt or headers.", {
            type: "object", properties: { active: { type: "integer" }, requests: { type: "integer" }, events: { type: "integer" },
              connections: { type: "array", items: { type: "object", properties: { id: { type: "string" }, kind: { enum: ["chat", "events"] },
                startedAt: { type: "integer" }, model: { type: "string" }, ip: { type: "string" }, appId: { type: "string" } } } } },
          }), "401": error("Missing or invalid token."), "403": error("Insufficient scope or different app.") },
        },
      },
      "/api/events": {
        get: {
          tags: ["events"],
          summary: "Server-sent events: usage.recorded, catalog.updated, pricing.updated.",
          responses: {
            "200": {
              description: "A `text/event-stream` with a heartbeat comment every 15s.",
              content: { "text/event-stream": { schema: ref("SseEvent") } },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["health"],
          summary: "This document.",
          responses: { "200": ok("The OpenAPI 3.1 document.", { type: "object" }) },
        },
      },
      "/v1/responses": {
        post: {
          tags: ["openai"],
          summary: "Native OpenAI Responses, streaming or not; requires write:chat.",
          requestBody: body({ type: "object", required: ["model"], properties: { model: { type: "string" }, input: {}, stream: { type: "boolean" } } }),
          responses: { "200": ok("Native Responses JSON or SSE."), "400": error("Invalid protocol routing."), "401": error("Missing gateway credentials."), "403": error("insufficient_scope") },
        },
      },
      "/v1/messages": {
        post: {
          tags: ["anthropic"],
          summary: "Native Anthropic Messages, streaming or not; requires write:chat.",
          requestBody: body({ type: "object", required: ["model"], properties: { model: { type: "string" }, messages: { type: "array" }, stream: { type: "boolean" } } }),
          responses: { "200": ok("Native message JSON or SSE."), "400": error("Invalid or ambiguous protocol routing."), "401": error("Missing gateway credentials."), "403": error("insufficient_scope") },
        },
      },
      "/v1/chat/completions": {
        post: {
          tags: ["openai"],
          summary: "OpenAI-compatible chat completion, streaming or not.",
          requestBody: body(ref("ChatCompletionRequest")),
          responses: {
            "200": {
              description: "A completion, or a `text/event-stream` of `chat.completion.chunk` frames when `stream` is true.",
              content: {
                "application/json": { schema: ref("ChatCompletionResponse") },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            "400": error("The request is invalid."),
            "401": error("The bearer token is missing or wrong."),
            "404": error("The provider or model is unknown."),
            "502": error("The provider failed."),
          },
        },
      },
      "/v1/models": {
        get: {
          tags: ["openai"],
          summary: "OpenAI-compatible model list.",
          parameters: [param("provider", { type: "string" }, "Restrict to one provider.")],
          responses: { "200": ok("The model list.", ref("ModelList")) },
        },
      },
    },
    components: {
      schemas: schemas(),
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "`Authorization: Bearer <token>`" },
      },
    },
  }

  if (security.length > 0) document.security = security
  return document
}
