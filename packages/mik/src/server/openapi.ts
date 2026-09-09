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
        apiKeyRef: { type: "string", description: "A reference such as `env:DEEPSEEK_API_KEY`, never a secret." },
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
        apiKeyRef: { type: "string" },
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
        avgLatencyMs: { type: "number" },
        firstTokenMs: { type: "number" },
      },
    },
    UsageTrendPoint: {
      type: "object",
      properties: {
        date: { type: "string" },
        requests: { type: "integer" },
        costUsd: { type: "number" },
        tokens: ref("TokenUsage"),
      },
    },
    UsageBucket: {
      type: "object",
      properties: {
        key: { type: "string" },
        requests: { type: "integer" },
        costUsd: { type: "number" },
        tokens: ref("TokenUsage"),
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
          responses: { "200": ok("The models.", { type: "object", properties: { models: { type: "array", items: ref("ModelInfo") } } }) },
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
      "/api/usage/logs": {
        get: {
          tags: ["usage"],
          summary: "Request detail, newest first.",
          parameters: USAGE_PARAMS,
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
