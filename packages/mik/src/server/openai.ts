import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { ModelMessage } from "ai"
import { isModelInfraError } from "../errors.js"
import { splitModelRef } from "../registry/registry.js"
import type { ModelRequest, ModelResponse, StreamEvent, TokenUsage, ToolCall } from "../types.js"
import { redact } from "../util/redact.js"
import { HttpError, type ServerContext } from "./context.js"
import { readJsonBody, sendError, sendJson, statusForCode } from "./http.js"
import { SseStream } from "./sse.js"

/** The roles the AI SDK accepts in a `ModelMessage`. */
const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool", "developer"])

/** AI SDK finish reasons mapped onto OpenAI's vocabulary. */
const FINISH_REASONS: Record<string, string> = {
  stop: "stop",
  length: "length",
  "tool-calls": "tool_calls",
  "content-filter": "content_filter",
  error: "stop",
  other: "stop",
  unknown: "stop",
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (isModelInfraError(error)) return new HttpError(statusForCode(error.code), error.message, error.code)
  const message = error instanceof Error ? error.message : String(error)
  return new HttpError(500, message || "Internal server error.", "UNKNOWN")
}

/**
 * The HTTP body is untyped JSON. Every field the hub relies on is validated
 * here; the remaining keys (`content` parts, `tool_calls`, …) are read by the
 * AI SDK itself, which is why this one boundary cast is unavoidable.
 */
function toModelMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "'messages' must be a non-empty array.", "INVALID_REQUEST")
  }
  const messages: ModelMessage[] = []
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, `messages[${index}] must be an object.`, "INVALID_REQUEST")
    }
    const record = item as Record<string, unknown>
    if (typeof record.role !== "string" || !MESSAGE_ROLES.has(record.role)) {
      throw new HttpError(
        400,
        `messages[${index}].role must be one of: ${[...MESSAGE_ROLES].join(", ")}.`,
        "INVALID_REQUEST",
      )
    }
    messages.push(record as unknown as ModelMessage)
  }
  return messages
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === "string" && value.trim()) return value.trim()
  if (Array.isArray(value) && value[0]?.trim()) return value[0].trim()
  return null
}

/**
 * `model` accepts `provider:model` or a bare model id, in which case
 * `X-ModelHub-Provider` picks the provider. With the header set and no model,
 * the configured default model's id is used with that provider.
 */
function resolveModelRef(ctx: ServerContext, model: string | undefined, provider: string | null): string | undefined {
  if (!provider) return model
  if (model) return model.startsWith(`${provider}:`) ? model : `${provider}:${model}`
  const fallback = ctx.hub.providers.defaultModel()
  const parsed = fallback ? splitModelRef(fallback) : null
  if (!parsed) {
    throw new HttpError(
      400,
      "X-ModelHub-Provider was set but no model was given and no default model is configured.",
      "INVALID_REQUEST",
    )
  }
  return `${provider}:${parsed.modelId}`
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function toOpenAiUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
    completion_tokens_details: { reasoning_tokens: usage.reasoning },
  }
}

function toOpenAiToolCalls(calls: ToolCall[]): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
  }))
}

function finishReason(value: string): string {
  return FINISH_REASONS[value] ?? "stop"
}

/** One `chat.completion.chunk` frame. */
function chunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finish: string | null,
  usage?: Record<string, unknown>,
): string {
  const frame: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  }
  if (usage) frame.usage = usage
  return `data: ${JSON.stringify(frame)}\n\n`
}

function toOpenAiCompletion(response: ModelResponse, id: string, created: number): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: response.text.length > 0 ? response.text : null }
  if (response.toolCalls.length > 0) message.tool_calls = toOpenAiToolCalls(response.toolCalls)
  return {
    id,
    object: "chat.completion",
    created,
    model: response.model.actual,
    choices: [{ index: 0, message, finish_reason: finishReason(response.finishReason), logprobs: null }],
    usage: toOpenAiUsage(response.usage),
    // Additive: what the hub metered for this call. OpenAI clients ignore it.
    x_modelhub: {
      provider: response.provider,
      model_requested: response.model.requested,
      cost_usd: response.cost.usd,
      cost_source: response.cost.source,
      latency_ms: response.latencyMs,
      first_token_ms: response.firstTokenMs ?? null,
      steps: response.steps ?? 1,
    },
  }
}

/** `POST /v1/chat/completions` — streaming and non-streaming. */
export async function handleChatCompletions(ctx: ServerContext): Promise<void> {
  const body = await readJsonBody(ctx.req)
  const provider = headerValue(ctx.req, "x-modelhub-provider")
  const model = resolveModelRef(ctx, typeof body.model === "string" ? body.model : undefined, provider)
  const messages = toModelMessages(body.messages)

  const request: ModelRequest = { messages }
  if (model !== undefined) request.model = model
  const temperature = numberField(body.temperature)
  if (temperature !== undefined) request.temperature = temperature
  const maxTokens = numberField(body.max_tokens) ?? numberField(body.max_completion_tokens)
  if (maxTokens !== undefined) request.maxTokens = maxTokens
  if (typeof body.user === "string" && body.user.trim()) request.sessionId = body.user.trim()
  request.tags = { entrypoint: "openai-http" }

  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  if (body.stream === true) {
    await streamCompletion(ctx, request, id, created)
    return
  }

  const response = await ctx.hub.generate(request)
  sendJson(ctx.res, 200, toOpenAiCompletion(response, id, created))
}

/**
 * Stream one completion.
 *
 * The first event is awaited before any byte is written, so a request that can
 * never be routed still gets a normal JSON error with the right status instead
 * of a 200 with an error frame inside it.
 */
async function streamCompletion(ctx: ServerContext, request: ModelRequest, id: string, created: number): Promise<void> {
  const controller = new AbortController()
  // `close` fires when the client goes away. If the response already ended
  // cleanly this is the normal teardown, not a cancellation.
  ctx.res.once("close", () => {
    if (!ctx.res.writableEnded) controller.abort()
  })
  request.signal = controller.signal

  const iterator = ctx.hub.stream(request)[Symbol.asyncIterator]()
  let first: IteratorResult<StreamEvent>
  try {
    first = await iterator.next()
  } catch (error) {
    throw toHttpError(error)
  }

  if (first.done) {
    const empty = new SseStream(ctx.res, 0)
    empty.open()
    await empty.raw("data: [DONE]\n\n")
    empty.close()
    return
  }

  if (first.value.type === "error") {
    // The hub records the usage row when its generator *finishes*, not when the
    // error event is yielded, so the stream must be drained before answering —
    // otherwise a request that failed would silently go unmetered.
    await settle(iterator)
    const { code, message } = first.value.error
    sendError(ctx.res, statusForCode(code), message, code)
    return
  }

  const stream = new SseStream(ctx.res, ctx.heartbeatMs)
  stream.open()
  stream.startHeartbeat()

  const modelId = resolveModelId(ctx, request)
  await stream.raw(chunk(id, created, modelId, { role: "assistant" }, null))

  const toolIndexes = new Map<string, number>()
  const streamedToolCalls = new Set<string>()
  let finish: ModelResponse | undefined
  let failure: { code: string; message: string } | undefined

  const emit = async (event: StreamEvent): Promise<void> => {
    switch (event.type) {
      case "text_delta":
        await stream.raw(chunk(id, created, modelId, { content: event.text }, null))
        break
      case "tool_call_delta": {
        const index = toolIndexes.get(event.id) ?? toolIndexes.size
        toolIndexes.set(event.id, index)
        streamedToolCalls.add(event.id)
        await stream.raw(
          chunk(
            id,
            created,
            modelId,
            {
              tool_calls: [
                { index, id: event.id, type: "function", function: { name: event.name, arguments: event.delta } },
              ],
            },
            null,
          ),
        )
        break
      }
      case "tool_call_complete": {
        // A provider that only reports the finished call gets one full frame.
        if (streamedToolCalls.has(event.call.id)) break
        const index = toolIndexes.size
        toolIndexes.set(event.call.id, index)
        await stream.raw(
          chunk(
            id,
            created,
            modelId,
            {
              tool_calls: [
                {
                  index,
                  id: event.call.id,
                  type: "function",
                  function: { name: event.call.name, arguments: JSON.stringify(event.call.input ?? {}) },
                },
              ],
            },
            null,
          ),
        )
        break
      }
      case "finish":
        finish = event.response
        break
      case "error":
        failure = event.error
        break
      default:
        // `usage` and `step_finish` are folded into the final chunk.
        break
    }
  }

  await emit(first.value)
  // Drain to completion even after an `error` event: the hub records the usage
  // row *after* the last event it yields, so abandoning the iterator here would
  // silently drop the metering row of every failed (or client-aborted) stream.
  for (;;) {
    let next: IteratorResult<StreamEvent>
    try {
      next = await iterator.next()
    } catch (error) {
      failure = { code: "UNKNOWN", message: redact(error instanceof Error ? error.message : String(error)) }
      break
    }
    if (next.done) break
    await emit(next.value)
  }

  if (failure) {
    await stream.raw(
      `data: ${JSON.stringify({
        error: { message: redact(failure.message), type: "server_error", code: failure.code },
      })}\n\n`,
    )
    await stream.raw("data: [DONE]\n\n")
    stream.close()
    return
  }

  const actualModel = finish?.model.actual ?? modelId
  await stream.raw(
    chunk(id, created, actualModel, {}, finishReason(finish?.finishReason ?? "stop"), toOpenAiUsage(finish?.usage ?? emptyUsage())),
  )
  await stream.raw("data: [DONE]\n\n")
  stream.close()
}

function resolveModelId(ctx: ServerContext, request: ModelRequest): string {  try {
    return ctx.hub.resolveModel(request.model).modelId
  } catch {
    return request.model ?? "unknown"
  }
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/**
 * Run a stream to its end without emitting anything, so the hub's bookkeeping
 * (usage recording, upstream teardown) completes. Bounded: a provider that
 * never closes its stream must not hold the HTTP response open forever.
 */
async function settle(iterator: AsyncIterator<StreamEvent>, timeoutMs = 2000): Promise<void> {
  const drain = (async () => {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
    }
  })().catch(() => undefined)

  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([drain, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** `GET /v1/models` — the stored catalogue, in OpenAI's list shape. */
export function handleListModels(ctx: ServerContext): void {
  const provider = ctx.url.searchParams.get("provider") ?? undefined
  const data = ctx.hub.models.list(provider).map((model) => ({
    id: model.ref,
    object: "model",
    created: Math.floor((model.syncedAt ?? 0) / 1000),
    owned_by: model.providerId,
  }))
  sendJson(ctx.res, 200, { object: "list", data })
}
