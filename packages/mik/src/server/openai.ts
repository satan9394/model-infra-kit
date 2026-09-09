import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { jsonSchema, type JSONSchema7, type ModelMessage, type ToolSet } from "ai"
import { isModelInfraError } from "../errors.js"
import { splitModelRef } from "../registry/registry.js"
import type { ModelRequest, ModelResponse, StreamEvent, TokenUsage, ToolCall } from "../types.js"
import { redact } from "../util/redact.js"
import { HttpError, type ServerContext } from "./context.js"
import { readJsonBody, sendError, sendJson, statusForCode } from "./http.js"
import { SseStream } from "./sse.js"

/** The roles an OpenAI client may send. `system`/`developer` are hoisted out. */
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

/** A prompt split into the two places the AI SDK accepts instructions. */
interface Prompt {
  messages: ModelMessage[]
  /** `system`/`developer` text, merged in the order it was sent. */
  system?: string
}

interface ToolCallPart {
  type: "tool-call"
  toolCallId: string
  toolName: string
  input: unknown
}

interface TextPart {
  type: "text"
  text: string
}

interface ImagePart {
  type: "image"
  image: URL
}

type UserPart = TextPart | ImagePart
type AssistantPart = TextPart | ToolCallPart

function badRequest(message: string): HttpError {
  return new HttpError(400, message, "INVALID_REQUEST")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textParts(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).filter((text) => text.length > 0)
}

/** The instructions carried by one `system`/`developer` message. */
function systemText(content: unknown, index: number): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return textParts(content).join("\n")
  throw badRequest(`messages[${index}].content must be a string or an array of text parts.`)
}

/** OpenAI content parts → AI SDK content parts (text and images). */
function contentParts(content: unknown, index: number): UserPart[] {
  if (!Array.isArray(content)) throw badRequest(`messages[${index}].content must be an array of parts.`)
  return content.map((part, partIndex) => {
    if (!isRecord(part)) throw badRequest(`messages[${index}].content[${partIndex}] must be an object.`)
    if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text }
    if (part.type === "image_url") {
      const url = isRecord(part.image_url) ? part.image_url.url : part.image_url
      if (typeof url !== "string") {
        throw badRequest(`messages[${index}].content[${partIndex}].image_url.url must be a string.`)
      }
      try {
        return { type: "image", image: new URL(url) }
      } catch {
        throw badRequest(`messages[${index}].content[${partIndex}].image_url.url is not a valid URL.`)
      }
    }
    throw badRequest(`messages[${index}].content[${partIndex}].type is not supported.`)
  })
}

function userMessage(record: Record<string, unknown>, index: number): ModelMessage {
  const content = record.content
  if (typeof content === "string") return { role: "user", content }
  return { role: "user", content: contentParts(content, index) }
}

/** One entry of an OpenAI `assistant.tool_calls` array. */
function toolCallPart(raw: unknown, index: number, callIndex: number): ToolCallPart {
  if (!isRecord(raw)) throw badRequest(`messages[${index}].tool_calls[${callIndex}] must be an object.`)
  const id = raw.id
  if (typeof id !== "string" || id.length === 0) {
    throw badRequest(`messages[${index}].tool_calls[${callIndex}].id must be a non-empty string.`)
  }
  const fn = raw.function
  if (!isRecord(fn)) throw badRequest(`messages[${index}].tool_calls[${callIndex}].function must be an object.`)
  const name = fn.name
  if (typeof name !== "string" || name.length === 0) {
    throw badRequest(`messages[${index}].tool_calls[${callIndex}].function.name must be a non-empty string.`)
  }
  const args = fn.arguments
  let input: unknown = {}
  if (typeof args === "string") {
    if (args.trim().length > 0) {
      try {
        input = JSON.parse(args)
      } catch {
        throw badRequest(`messages[${index}].tool_calls[${callIndex}].function.arguments must be valid JSON.`)
      }
    }
  } else if (args !== undefined && args !== null) {
    // Some clients already send the parsed arguments object.
    input = args
  }
  return { type: "tool-call", toolCallId: id, toolName: name, input }
}

/** An assistant turn: plain text, or text plus the tool calls it asked for. */
function assistantMessage(
  record: Record<string, unknown>,
  index: number,
  toolNames: Map<string, string>,
): ModelMessage {
  const content = record.content
  const calls = record.tool_calls
  if (calls === undefined || calls === null) {
    if (typeof content === "string") return { role: "assistant", content }
    if (content === null || content === undefined) return { role: "assistant", content: "" }
    if (!Array.isArray(content)) throw badRequest(`messages[${index}].content must be a string or an array of parts.`)
    return { role: "assistant", content: textParts(content).map((text) => ({ type: "text", text })) }
  }
  if (!Array.isArray(calls)) throw badRequest(`messages[${index}].tool_calls must be an array.`)
  const parts: AssistantPart[] = []
  if (typeof content === "string" && content.length > 0) parts.push({ type: "text", text: content })
  for (const [callIndex, raw] of calls.entries()) {
    const part = toolCallPart(raw, index, callIndex)
    toolNames.set(part.toolCallId, part.toolName)
    parts.push(part)
  }
  return { role: "assistant", content: parts }
}

/** The result the client is handing back for one `tool_call_id`. */
function toolResultText(content: unknown, index: number): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return textParts(content).join("\n")
  if (content === null || content === undefined) return ""
  return JSON.stringify(content)
}

function toolMessage(record: Record<string, unknown>, index: number, toolNames: Map<string, string>): ModelMessage {
  const toolCallId = record.tool_call_id
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    throw badRequest(`messages[${index}].tool_call_id is required for role "tool".`)
  }
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        // The AI SDK requires a name; the OpenAI wire format does not carry it,
        // so it is recovered from the assistant turn that made the call.
        toolName: toolNames.get(toolCallId) ?? "unknown",
        output: { type: "text", value: toolResultText(record.content, index) },
      },
    ],
  }
}

/**
 * Turn an OpenAI `messages` array into the shape the AI SDK accepts.
 *
 * `system` and `developer` messages are hoisted into `Prompt.system` (joined
 * with blank lines, in the order they were sent) because `generateText` rejects
 * them inside `messages`. Every other field is validated here; the AI SDK still
 * owns the wire mapping, which is why the remaining boundary casts are needed.
 */
function toPrompt(value: unknown): Prompt {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "'messages' must be a non-empty array.", "INVALID_REQUEST")
  }
  const messages: ModelMessage[] = []
  const system: string[] = []
  const toolNames = new Map<string, string>()
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw badRequest(`messages[${index}] must be an object.`)
    const role = item.role
    if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) {
      throw new HttpError(
        400,
        `messages[${index}].role must be one of: ${[...MESSAGE_ROLES].join(", ")}.`,
        "INVALID_REQUEST",
      )
    }
    switch (role) {
      case "system":
      case "developer":
        system.push(systemText(item.content, index))
        break
      case "user":
        messages.push(userMessage(item, index))
        break
      case "assistant":
        messages.push(assistantMessage(item, index, toolNames))
        break
      case "tool":
        messages.push(toolMessage(item, index, toolNames))
        break
      default:
        throw badRequest(`messages[${index}].role is not supported.`)
    }
  }
  return system.length > 0 ? { messages, system: system.join("\n\n") } : { messages }
}

/**
 * OpenAI `tools` → AI SDK `ToolSet`.
 *
 * No `execute` is attached on purpose: this endpoint only reports the model's
 * `tool_calls` back to the client, which runs the tool itself and sends the
 * result as a `role: "tool"` message on the next turn.
 */
function toTools(value: unknown): ToolSet | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw badRequest("'tools' must be an array.")
  const tools: ToolSet = {}
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw badRequest(`tools[${index}] must be an object.`)
    if (item.type !== undefined && item.type !== "function") {
      throw badRequest(`tools[${index}].type must be "function".`)
    }
    const fn = item.function
    if (!isRecord(fn)) throw badRequest(`tools[${index}].function must be an object.`)
    const name = fn.name
    if (typeof name !== "string" || name.length === 0) {
      throw badRequest(`tools[${index}].function.name must be a non-empty string.`)
    }
    const parameters = fn.parameters
    if (parameters !== undefined && parameters !== null && !isRecord(parameters)) {
      throw badRequest(`tools[${index}].function.parameters must be a JSON Schema object.`)
    }
    tools[name] = {
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      inputSchema: jsonSchema((parameters ?? { type: "object", properties: {} }) as JSONSchema7),
    }
  }
  return Object.keys(tools).length > 0 ? tools : undefined
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (isModelInfraError(error)) return new HttpError(statusForCode(error.code), error.message, error.code)
  const message = error instanceof Error ? error.message : String(error)
  return new HttpError(500, message || "Internal server error.", "UNKNOWN")
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

/**
 * `hasToolCalls` forces `tool_calls` when a provider reported the call but
 * labelled the turn `stop`: a client that sees `stop` never runs the tool.
 */
function finishReason(value: string, hasToolCalls = false): string {
  const mapped = FINISH_REASONS[value] ?? "stop"
  return hasToolCalls && mapped === "stop" ? "tool_calls" : mapped
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
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason(response.finishReason, response.toolCalls.length > 0),
        logprobs: null,
      },
    ],
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
  const prompt = toPrompt(body.messages)
  const tools = toTools(body.tools)

  const request: ModelRequest = { messages: prompt.messages }
  if (prompt.system !== undefined) request.system = prompt.system
  if (tools !== undefined) request.tools = tools
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
    chunk(
      id,
      created,
      actualModel,
      {},
      finishReason(finish?.finishReason ?? "stop", (finish?.toolCalls.length ?? 0) > 0),
      toOpenAiUsage(finish?.usage ?? emptyUsage()),
    ),
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
