import { pricingRequest } from "./pricing/request-context.js"
import { randomUUID } from "node:crypto"
import { MODEL_LIST_PROTOCOLS } from "./ai/protocols.js"
import { isModelInfraError, ModelInfraError, toModelInfraError, type ModelInfraErrorCode } from "./errors.js"
import { reportedCostFromUsage, type ProviderCostReading } from "./pricing/reported-cost.js"
import type { ResolvedProvider } from "./registry/registry.js"
import type { TokenUsage } from "./types.js"
import { isRetryableRouteFailure } from "./router/circuit-breaker.js"
import { redact, redactDeep } from "./util/redact.js"

const anthropicWireProtocols: Readonly<Record<string, boolean>> = { anthropic: true }

/** A call that was forwarded to a provider and should be metered. */
export interface ForwardedCall {
  routingTags?: Record<string, string>
  batch?: boolean
  requestId: string
  /** When the caller sent the request. */
  at: number
  providerId: string
  /** The model reference as the caller wrote it, e.g. `deepseek:deepseek-chat`. */
  modelRequested: string
  /** The model id the provider actually answered with. */
  modelActual: string
  /** Physical channel selected before a provider rewrites its response model. */
  modelRouted?: string
  /** Per-attempt completion time; legacy latencyMs remains time to headers. */
  qosRttMs?: number
  usage: TokenUsage
  latencyMs: number
  firstTokenMs?: number
  status: "ok" | "error"
  errorCode?: string
  isStreaming: boolean
  sessionId?: string
  traceId?: string
  /**
   * The amount the endpoint said it billed (EVO-G73), read straight from the
   * response body this adapter already parses. `absent` for every provider that
   * does not report one, which keeps the pre-G73 accounting path unchanged.
   */
  providerCost?: ProviderCostReading
}

/** The model a request should be routed to. */
export interface FetchTarget {
  routingTags?: Record<string, string>
  fallback?: FetchTarget
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
  resolveRequest?(payload: Record<string, unknown>, headers: Record<string, string>): FetchTarget
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
const HOP_HEADERS = [
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "accept-encoding",
  "x-mik-session-id",
  "x-mik-trace-id",
  "x-mik-model-tier",
]

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
 * back for pricing and storage. Successful payload bytes are preserved; provider
 * error bodies/frames and headers are sanitized before reaching the caller.
 */
export function createMikFetch(options: MikFetchOptions): typeof fetch {
  const now = options.now ?? Date.now
  const nextId = options.requestId ?? (() => randomUUID())

  const forward = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    override?: FetchTarget,
    cascadeTraceId?: string,
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
    const batch = request.headers.get("x-mik-batch") === "true" || payload?.batch === true || payload?.["X-Mik-Batch"] === true || payload?.["X-Mik-Batch"] === "true" || pricingRequest.getStore()?.batch === true
    const requestedModel = typeof payload?.model === "string" ? payload.model : undefined
    const metadata = payload ? asRecord(payload.metadata) : null
    const sessionId = textValue(payload?.session_id) ?? textValue(payload?.user) ?? textValue(request.headers.get("x-mik-session-id"))
    let traceId = cascadeTraceId ?? textValue(payload?.trace_id) ?? textValue(metadata?.trace_id) ?? textValue(request.headers.get("x-mik-trace-id"))
    const isGeneration = request.method !== "GET" && request.method !== "HEAD"

    // A body that cannot be parsed cannot be routed, and forwarding it verbatim
    // would hide the mistake from the caller.
    if (isGeneration && bodyText.trim() && payload === null) {
      return errorResponse(400, "The request body must be a JSON object.", "INVALID_REQUEST")
    }

    let target: FetchTarget
    try {
      const routingHeaders: Record<string, string> = {}
      request.headers.forEach((value, key) => { routingHeaders[key] = value })
      target = override ?? (isGeneration && payload && options.resolveRequest ? options.resolveRequest(payload, routingHeaders) : options.resolveModel(requestedModel))
      if (target.routingTags) traceId ??= nextId()
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

    const outgoing: Record<string, unknown> | undefined = isGeneration && payload ? { ...payload, model: target.modelId } : undefined
    // These MIK-only attribution fields are consumed locally and are not sent
    // to providers that may reject OpenAI-compatible extension properties.
    if (outgoing) {
      delete outgoing.batch
      delete outgoing["X-Mik-Batch"]
      delete outgoing.session_id
      delete outgoing.trace_id
    }
    const transport = options.fetch ?? globalThis.fetch
    const qosStarted = performance.now()

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
        ...(batch ? { batch: true } : {}),
        routingTags: target.routingTags,
        requestId,
        at: startedAt,
        providerId: target.providerId,
        modelRequested: target.requested,
        modelActual: target.modelId,
        modelRouted: target.modelId,
        qosRttMs: performance.now() - qosStarted,
        usage: ZERO_USAGE(),
        latencyMs: now() - startedAt,
        status: "error",
        errorCode: "CONNECTION",
        isStreaming: false,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(traceId === undefined ? {} : { traceId }),
      })
      if (target.fallback && !request.signal.aborted) return forward(input, init, target.fallback, traceId)
      return errorResponse(502, `Could not reach provider "${target.providerId}".`, "CONNECTION")
    }

    response = await sanitizeProviderResponse(response, provider.apiKey)
    const latencyMs = now() - startedAt
    const meter = (
      usage: TokenUsage,
      modelActual: string,
      firstTokenMs: number | undefined,
      isStreaming: boolean,
      providerCost?: ProviderCostReading,
      streamError?: ModelInfraError,
    ) => {
      options.onCall({
        ...(batch ? { batch: true } : {}),
        routingTags: target.routingTags,
        requestId,
        at: startedAt,
        providerId: target.providerId,
        modelRequested: target.requested,
        modelActual,
        modelRouted: target.modelId,
        usage,
        latencyMs,
        qosRttMs: performance.now() - qosStarted,
        firstTokenMs,
        status: response.ok && !streamError ? "ok" : "error",
        errorCode: streamError?.code ?? (response.ok ? undefined : codeForStatus(response.status)),
        isStreaming,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(traceId === undefined ? {} : { traceId }),
        ...(providerCost === undefined ? {} : { providerCost }),
      })
    }

    if (!isGeneration) return response

    if (!response.ok) {
      meter(ZERO_USAGE(), target.modelId, undefined, false)
      if (target.fallback && !request.signal.aborted && (response.status === 429 || response.status >= 500 && response.status <= 599)) {
        await response.body?.cancel()
        return forward(input, init, target.fallback, traceId)
      }
      return response
    }

    if (target.fallback && isEventStream(response)) {
      const primed = await primeCascadeStream(response)
      response = primed.response
      if (primed.error) {
        options.onCall({ requestId, at: startedAt, providerId: target.providerId, modelRequested: target.requested,
          modelActual: target.modelId, modelRouted: target.modelId, usage: ZERO_USAGE(), latencyMs: now() - startedAt, status: "error",
          errorCode: primed.error.code, isStreaming: true, sessionId, traceId, routingTags: target.routingTags, batch })
        if (!request.signal.aborted && isRetryableRouteFailure(primed.error)) return forward(input, init, target.fallback, traceId)
        return errorResponse(statusForCode(primed.error.code), primed.error.message, primed.error.code)
      }
    }

    if (isEventStream(response)) {
      if (!response.body) {
        meter(ZERO_USAGE(), target.modelId, undefined, true)
        return response
      }
      const scanner = createSseScanner(startedAt, now, anthropicWireProtocols[provider.protocol] ?? false)
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
            meter(found.usage ?? ZERO_USAGE(), found.model ?? target.modelId, found.firstTokenMs, true, found.cost, found.error)
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
    const found = anthropicWireProtocols[provider.protocol] ? readAnthropicUsage(parsed) : readOpenAiUsage(parsed)
    meter(found?.usage ?? ZERO_USAGE(), found?.model ?? target.modelId, undefined, false, found?.cost,
      parsed?.error ? toModelInfraError(parsed.error) : undefined)
    if (parsed?.error) return sanitizeProviderResponse(response, provider.apiKey, true)
    return response
  }

  return forward as typeof fetch
}

/** Provider errors can echo even credentials without a recognizable prefix. */
async function sanitizeProviderResponse(response: Response, apiKey: string | null, errorPayload = false): Promise<Response> {
  const mask = (text: string): string => {
    if (apiKey) text = text.replaceAll(apiKey, "[REDACTED]").replaceAll(JSON.stringify(apiKey).slice(1, -1), "[REDACTED]")
    return redact(text)
  }
  const safeJson = (text: string): string => {
    try { return mask(JSON.stringify(redactDeep(JSON.parse(text), 0, 32))) }
    catch { return mask(text) }
  }
  const fields: Record<string, string> = {}
  response.headers.forEach((value, key) => { fields[key] = mask(value) })
  const headers = new Headers(redactDeep(fields))
  const rewritten = !response.ok || errorPayload || isEventStream(response)
  if (rewritten) for (const key of ["content-length", "content-encoding", "transfer-encoding", "etag", "content-md5", "digest"]) headers.delete(key)
  const init = { status: response.status, statusText: mask(response.statusText), headers }
  if (isEventStream(response) && response.body) {
    const decoder = new TextDecoder(), encoder = new TextEncoder()
    let pending = ""
    let lines: string[] = [], eventCharacters = 0
    const event = (): string => {
      const data = lines.filter(text => text.startsWith("data:"))
        .map(text => text.replace(/\r?\n$/, "").slice(5).replace(/^ /, "")).join("\n")
      let safe = "", rewrite = false
      try {
        const value = JSON.parse(data)
        safe = safeJson(data)
        rewrite = !!value?.error || value?.type === "error" || safe !== JSON.stringify(value)
      } catch { /* non-JSON event: literal credential masking still applies */ }
      let replaced = false
      const text = lines.map(line => {
        if (!rewrite || !line.startsWith("data:")) return mask(line)
        if (replaced) return ""
        replaced = true
        return `data: ${safe}${line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""}`
      }).join("")
      lines = []; eventCharacters = 0
      return text
    }
    const reader = response.body.getReader()
    // Stream rejections are an outbound error surface too; never expose their raw cause.
    const guarded = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) { reader.releaseLock(); controller.close() }
          else controller.enqueue(next.value)
        } catch (error) {
          reader.releaseLock()
          controller.error(new Error(mask(error instanceof Error ? error.message : String(error))))
        }
      },
      async cancel(reason) { try { await reader.cancel(reason).catch(() => {}) } finally { reader.releaseLock() } },
    })
    // ponytail: assemble bounded SSE events, since multiple data fields form one JSON payload.
    const body = guarded.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        let start = 0, end: number
        while ((end = pending.indexOf("\n", start)) >= 0) {
          const line = pending.slice(start, end + 1)
          eventCharacters += line.length
          if (eventCharacters > 4 * 1024 * 1024) throw new Error("Provider SSE event exceeds 4 MiB limit")
          lines.push(line)
          if (line === "\n" || line === "\r\n") controller.enqueue(encoder.encode(event()))
          start = end + 1
        }
        pending = pending.slice(start)
        if (eventCharacters + pending.length > 4 * 1024 * 1024) throw new Error("Provider SSE event exceeds 4 MiB limit")
      },
      flush(controller) {
        pending += decoder.decode()
        if (pending) lines.push(pending)
        if (lines.length) controller.enqueue(encoder.encode(event()))
      },
    }))
    return new Response(body, init)
  }
  if ((!errorPayload && response.ok) || !response.body) return new Response(response.body, init)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let text = "", bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > 65_536) throw new Error("Provider error body exceeds 64 KiB limit")
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
  } catch { text = "Provider error body unavailable or exceeds 64 KiB limit" }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return new Response(safeJson(text), init)
}

/** Buffer native SSE only until output commits; never replay text or tool work. */
async function primeCascadeStream(response: Response): Promise<{ response: Response; error?: ModelInfraError }> {
  if (!response.body) return { response }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  let pending = ""
  let bytes = 0
  let done = false
  let committed = false
  try {
    while (!done && !committed && bytes < 65_536) {
      const next = await reader.read()
      done = next.done
      if (next.value) { chunks.push(next.value); bytes += next.value.length }
      pending += decoder.decode(next.value, { stream: !done })
      let end = pending.indexOf("\n")
      while (end >= 0 && !committed) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
          let frame: Record<string, unknown> | undefined
          try { frame = JSON.parse(line.slice(5)) } catch { /* partial/non-JSON event */ }
          if (frame?.error) {
            await reader.cancel()
            reader.releaseLock()
            return { response, error: toModelInfraError(frame.error) }
          }
          if (frame) {
            const choices = frame.choices as Array<{ delta?: { content?: string; tool_calls?: unknown; reasoning_content?: string } }> | undefined
            committed = !!choices?.some(choice => choice.delta?.content || choice.delta?.tool_calls || choice.delta?.reasoning_content)
              || ["content_block_start", "content_block_delta", "response.output_text.delta", "response.function_call_arguments.delta"].includes(String(frame.type))
          }
        }
        end = pending.indexOf("\n")
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    return { response, error: toModelInfraError(error) }
  }
  // ponytail: a bounded prefix prevents unbounded metadata buffering; reaching it commits the stream.
  const body = new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk) },
    async pull(controller) {
      if (done) { controller.close(); reader.releaseLock(); return }
      try {
        const next = await reader.read()
        if (next.done) { done = true; controller.close(); reader.releaseLock() }
        else controller.enqueue(next.value)
      } catch (error) { controller.error(error); reader.releaseLock() }
    },
    async cancel(reason) { await reader.cancel(reason); reader.releaseLock() },
  })
  return { response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }) }
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

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
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
    if (AUTH_HEADERS.includes(lower) || HOP_HEADERS.includes(lower) || ["x-mik-batch", "x-mik-bypass-budget"].includes(lower)) return
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

/** Native Anthropic input excludes caches; normalized MIK input includes them. */
function readAnthropicUsage(payload: Record<string, unknown> | null, previous?: TokenUsage): {
  usage: TokenUsage
  model?: string
  cost?: ProviderCostReading
} | null {
  const message = asRecord(payload?.message) ?? payload
  const raw = asRecord(message?.usage)
  if (!raw) return null
  const cacheRead = asCount(raw.cache_read_input_tokens) ?? previous?.cacheRead ?? 0
  const cacheWrite = asCount(raw.cache_creation_input_tokens) ?? previous?.cacheWrite ?? 0
  const uncached = asCount(raw.input_tokens)
  return { usage: {
    // Anthropic reports uncached input separately; MIK input includes caches.
    input: uncached === undefined ? previous?.input ?? 0 : uncached + cacheRead + cacheWrite,
    output: asCount(raw.output_tokens) ?? previous?.output ?? 0,
    cacheRead, cacheWrite, reasoning: 0,
  }, model: typeof message?.model === "string" ? message.model : undefined }
}

/** Scan usage frames without changing a byte of the adapter's response. */
function createSseScanner(
  startedAt: number,
  now: () => number,
  anthropic = false,
): {
  consume(chunk: Uint8Array): void
  finish(): void
  result(): {
    error?: ModelInfraError
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
  let error: ModelInfraError | undefined

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
    if (parsed?.error) error = toModelInfraError(parsed.error)
    // The billed amount is read independently of the token counts: a gateway may
    // send `usage.cost` on a frame whose token fields this adapter does not use.
    const wirePayload = asRecord(parsed?.response) ?? parsed
    const reported = reportedCostFromUsage(wirePayload?.usage)
    if (reported.kind !== "absent") cost = reported
    const found = anthropic ? readAnthropicUsage(parsed, usage) : readOpenAiUsage(wirePayload)
    if (found) {
      usage = found.usage
      if (found.model) model = found.model
      return
    }
    if (wirePayload && typeof wirePayload.model === "string" && wirePayload.model) model = wirePayload.model
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
    result: () => ({ usage, model, firstTokenMs, cost, error }),
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
