import { randomUUID } from "node:crypto"
import { MODEL_LIST_PROTOCOLS } from "./ai/protocols.js"
import { isModelInfraError, ModelInfraError, type ModelInfraErrorCode } from "./errors.js"
import { reportedCostFromUsage, type ProviderCostReading } from "./pricing/reported-cost.js"
import type { ResolvedProvider } from "./registry/registry.js"
import type { TokenUsage } from "./types.js"
import { redact } from "./util/redact.js"

/** A call that was forwarded to a provider and should be metered. */
export interface ForwardedCall {
  requestId: string
  /** When the caller sent the request. */
  at: number
  providerId: string
  /** The model reference as the caller wrote it, e.g. `deepseek:deepseek-chat`. */
  modelRequested: string
  /** The model id the provider actually answered with. */
  modelActual: string
  usage: TokenUsage
  latencyMs: number
  firstTokenMs?: number
  status: "ok" | "error"
  errorCode?: string
  isStreaming: boolean
  /**
   * The amount the endpoint said it billed (EVO-G73), read straight from the
   * response body this adapter already parses. `absent` for every provider that
   * does not report one, which keeps the pre-G73 accounting path unchanged.
   */
  providerCost?: ProviderCostReading
}

/** The model a request should be routed to. */
export interface FetchTarget {
  providerId: string
  modelId: string
  /** What the caller asked for, or the configured default ref. */
  requested: string
}

export interface MikFetchOptions {
  /** `ProviderRegistry.resolve` — throws `PROVIDER_NOT_FOUND` / `CREDENTIAL`. */
  resolveProvider(providerId: string): ResolvedProvider
  /** The hub's model resolution, so a bare model id honours the default provider. */
  resolveModel(model?: string): FetchTarget
  /** Meter one forwarded call. Must never throw: the hub wraps it. */
  onCall(call: ForwardedCall): void
  /** The URL this adapter is published under, read on every call. */
  baseUrl(): string
  /** Transport override (tests). Defaults to `globalThis.fetch` at call time. */
  fetch?: typeof globalThis.fetch
  now?: () => number
  requestId?: () => string
}

const AUTH_HEADERS = ["authorization", "api-key", "x-api-key", "x-goog-api-key"]
/** Headers that describe this hop, not the upstream request. */
const HOP_HEADERS = ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]

const ZERO_USAGE = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

/**
 * A `fetch` implementation that makes an existing OpenAI-compatible client
 * metered without touching its code:
 *
 * ```ts
 * new OpenAI({ baseURL: mik.baseUrl, fetch: mik.fetch })
 * ```
 *
 * The request body's `model` picks the provider, the credential is attached by
 * the provider's protocol, and whatever `usage` the provider reports is handed
 * back for pricing and storage. The response is returned to the caller byte for
 * byte; the adapter only ever reads a clone.
 */
export function createMikFetch(options: MikFetchOptions): typeof fetch {
  const now = options.now ?? Date.now
  const nextId = options.requestId ?? (() => randomUUID())

  const forward = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let request: Request
    try {
      request = new Request(input, init)
    } catch (error) {
      return errorResponse(400, `Could not read the request: ${messageOf(error)}`, "INVALID_REQUEST")
    }

    const startedAt = now()
    const requestId = nextId()
    const url = new URL(request.url)

    const bodyText = await readBody(request)
    const payload = bodyText ? parseJson(bodyText) : null
    const requestedModel = typeof payload?.model === "string" ? payload.model : undefined
    const isGeneration = request.method !== "GET" && request.method !== "HEAD"

    // A body that cannot be parsed cannot be routed, and forwarding it verbatim
    // would hide the mistake from the caller.
    if (isGeneration && bodyText.trim() && payload === null) {
      return errorResponse(400, "The request body must be a JSON object.", "INVALID_REQUEST")
    }

    let target: FetchTarget
    try {
      target = options.resolveModel(requestedModel)
    } catch (error) {
      const mapped = isModelInfraError(error) ? error : new ModelInfraError(messageOf(error), { code: "INVALID_REQUEST" })
      return errorResponse(statusForCode(mapped.code), mapped.message, mapped.code)
    }

    let provider: ResolvedProvider
    try {
      provider = options.resolveProvider(target.providerId)
    } catch (error) {
      const mapped = isModelInfraError(error) ? error : new ModelInfraError(messageOf(error), { code: "PROVIDER_NOT_FOUND" })
      return errorResponse(statusForCode(mapped.code), mapped.message, mapped.code)
    }

    const base = provider.baseUrl?.replace(/\/+$/, "")
    if (!base) {
      return errorResponse(
        400,
        `Provider "${provider.record.id}" has no base URL. Set baseUrl or pick a preset that ships one.`,
        "INVALID_REQUEST",
      )
    }

    const outgoing = isGeneration && payload ? { ...payload, model: target.modelId } : undefined
    const transport = options.fetch ?? globalThis.fetch

    let response: Response
    try {
      response = await transport(`${base}${suffixFor(url, options.baseUrl())}${url.search}`, {
        method: request.method,
        headers: forwardHeaders(request.headers, provider),
        body: outgoing ? JSON.stringify(outgoing) : undefined,
        signal: request.signal,
      })
    } catch (error) {
      options.onCall({
        requestId,
        at: startedAt,
        providerId: target.providerId,
        modelRequested: target.requested,
        modelActual: target.modelId,
        usage: ZERO_USAGE(),
        latencyMs: now() - startedAt,
        status: "error",
        errorCode: "CONNECTION",
        isStreaming: false,
      })
      return errorResponse(502, `Could not reach provider "${target.providerId}".`, "CONNECTION")
    }

    const latencyMs = now() - startedAt
    const meter = (
      usage: TokenUsage,
      modelActual: string,
      firstTokenMs: number | undefined,
      isStreaming: boolean,
      providerCost?: ProviderCostReading,
    ) => {
      options.onCall({
        requestId,
        at: startedAt,
        providerId: target.providerId,
        modelRequested: target.requested,
        modelActual,
        usage,
        latencyMs,
        firstTokenMs,
        status: response.ok ? "ok" : "error",
        errorCode: response.ok ? undefined : codeForStatus(response.status),
        isStreaming,
        ...(providerCost === undefined ? {} : { providerCost }),
      })
    }

    if (!isGeneration) return response

    if (!response.ok) {
      meter(ZERO_USAGE(), target.modelId, undefined, false)
      return response
    }

    if (isEventStream(response)) {
      if (!response.body) {
        meter(ZERO_USAGE(), target.modelId, undefined, true)
        return response
      }
      const scanner = createSseScanner(startedAt, now)
      let recorded = false
      const stream = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            scanner.consume(chunk)
            controller.enqueue(chunk)
          },
          flush() {
            scanner.finish()
            if (recorded) return
            recorded = true
            const found = scanner.result()
            meter(found.usage ?? ZERO_USAGE(), found.model ?? target.modelId, found.firstTokenMs, true, found.cost)
          },
        }),
      )
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
    }

    let parsed: Record<string, unknown> | null = null
    try {
      parsed = parseJson(await response.clone().text())
    } catch {
      parsed = null
    }
    const found = readOpenAiUsage(parsed)
    meter(found?.usage ?? ZERO_USAGE(), found?.model ?? target.modelId, undefined, false, found?.cost)
    return response
  }

  return forward as typeof fetch
}

/** Read a request body without consuming it for the caller. */
async function readBody(request: Request): Promise<string> {
  if (request.method === "GET" || request.method === "HEAD") return ""
  try {
    return await request.clone().text()
  } catch {
    return ""
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null
  try {
    const value = JSON.parse(text) as unknown
    return asRecord(value)
  } catch {
    return null
  }
}

/**
 * The path the caller asked for, relative to the published base URL.
 *
 * `http://127.0.0.1:3211/v1/chat/completions` against a published
 * `http://127.0.0.1:3211/v1` becomes `/chat/completions`, which is then appended
 * to the provider's own base URL (which already carries its `/v1`).
 */
function suffixFor(url: URL, baseUrl: string): string {
  let prefix = ""
  try {
    prefix = new URL(baseUrl).pathname.replace(/\/+$/, "")
  } catch {
    prefix = ""
  }
  const path = url.pathname
  const relative = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\/v1(?=\/|$)/, "")
  if (!relative) return "/"
  return relative.startsWith("/") ? relative : `/${relative}`
}

/**
 * Copy the caller's headers, drop anything that identifies this hop, and let the
 * provider's protocol supply the credential. A secret supplied by the caller is
 * never forwarded: only the configured one is.
 */
function forwardHeaders(incoming: Headers, provider: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = {}
  incoming.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (AUTH_HEADERS.includes(lower) || HOP_HEADERS.includes(lower)) return
    headers[lower] = value
  })
  const auth = MODEL_LIST_PROTOCOLS[provider.protocol]?.headers(provider) ?? {}
  for (const [key, value] of Object.entries(auth)) {
    if (key.toLowerCase() === "accept") continue
    headers[key.toLowerCase()] = value
  }
  headers["content-type"] = incoming.get("content-type") ?? "application/json"
  return headers
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * What an OpenAI-compatible payload says was used, if it says anything.
 *
 * `cost` is the endpoint's own billed amount when it reports one (EVO-G73): the
 * `usage` object it returns is parsed here already, so the reported amount needs
 * no second read of the body. It is left off the result entirely when the field
 * is absent, so the caller's fallback to the price catalogue is untouched.
 */
export function readOpenAiUsage(payload: Record<string, unknown> | null): {
  usage: TokenUsage
  model?: string
  cost?: ProviderCostReading
} | null {
  if (!payload) return null
  const usage = asRecord(payload.usage)
  if (!usage) return null

  const prompt = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details) ?? {}
  const completion = asRecord(usage.completion_tokens_details) ?? asRecord(usage.output_tokens_details) ?? {}

  const input = asCount(usage.prompt_tokens) ?? asCount(usage.input_tokens)
  const output = asCount(usage.completion_tokens) ?? asCount(usage.output_tokens)
  const cacheRead = asCount(prompt.cached_tokens) ?? asCount(usage.prompt_cache_hit_tokens) ?? asCount(prompt.cache_read_tokens)
  const cacheWrite = asCount(prompt.cache_creation_tokens) ?? asCount(prompt.cache_write_tokens)
  const reasoning = asCount(completion.reasoning_tokens) ?? asCount(completion.reasoning_token_count)
  const cost = reportedCostFromUsage(usage)

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    reasoning === undefined &&
    cost.kind === "absent"
  ) {
    return null
  }

  const model = typeof payload.model === "string" && payload.model ? payload.model : undefined
  return {
    usage: {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
      reasoning: reasoning ?? 0,
    },
    model,
    ...(cost.kind === "absent" ? {} : { cost }),
  }
}

/**
 * Scans a `text/event-stream` body for the frames that carry `usage`, without
 * changing a byte of what the caller receives.
 */
function createSseScanner(
  startedAt: number,
  now: () => number,
): {
  consume(chunk: Uint8Array): void
  finish(): void
  result(): {
    usage: TokenUsage | undefined
    model: string | undefined
    firstTokenMs: number | undefined
    cost: ProviderCostReading | undefined
  }
} {
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: TokenUsage | undefined
  let model: string | undefined
  let firstTokenMs: number | undefined
  let cost: ProviderCostReading | undefined

  const line = (text: string) => {
    if (firstTokenMs === undefined && text.trim()) firstTokenMs = now() - startedAt
    if (!text.startsWith("data:")) return
    const payload = text.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = asRecord(JSON.parse(payload) as unknown)
    } catch {
      return
    }
    // The billed amount is read independently of the token counts: a gateway may
    // send `usage.cost` on a frame whose token fields this adapter does not use.
    const reported = reportedCostFromUsage(parsed?.usage)
    if (reported.kind !== "absent") cost = reported
    const found = readOpenAiUsage(parsed)
    if (found) {
      usage = found.usage
      if (found.model) model = found.model
      return
    }
    if (parsed && typeof parsed.model === "string" && parsed.model) model = parsed.model
  }

  const drain = (flush: boolean) => {
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      line(buffer.slice(0, index).replace(/\r$/, ""))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
    }
    if (flush && buffer) {
      line(buffer.replace(/\r$/, ""))
      buffer = ""
    }
  }

  return {
    consume(chunk) {
      buffer += decoder.decode(chunk, { stream: true })
      drain(false)
    },
    finish() {
      buffer += decoder.decode()
      drain(true)
    },
    result: () => ({ usage, model, firstTokenMs, cost }),
  }
}

function messageOf(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
}

function codeForStatus(status: number): ModelInfraErrorCode {
  if (status === 401 || status === 403) return "AUTH"
  if (status === 404) return "MODEL_NOT_FOUND"
  if (status === 408 || status === 504) return "TIMEOUT"
  if (status === 429) return "RATE_LIMIT"
  if (status === 400 || status === 422) return "INVALID_REQUEST"
  if (status >= 500) return "PROVIDER"
  return "UNKNOWN"
}

function statusForCode(code: ModelInfraErrorCode): number {
  switch (code) {
    case "AUTH":
    case "CREDENTIAL":
      return 401
    case "PROVIDER_NOT_FOUND":
    case "MODEL_NOT_FOUND":
      return 404
    case "RATE_LIMIT":
      return 429
    case "TIMEOUT":
      return 504
    default:
      return 400
  }
}

/** An OpenAI-shaped error, with nothing from the credential in it. */
function errorResponse(status: number, message: string, code: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: redact(message),
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code,
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  )
}
