import { createHash } from "node:crypto"
import { redact, redactDeep } from "../util/redact.js"

export interface CacheKeyOptions {
  temperature?: number
  cache?: boolean
  headers?: Record<string, string>
  model?: string
  system?: string
  tools?: unknown
  maxTokens?: number
  batch?: boolean
  reasoning_effort?: unknown
  reasoning?: unknown
  thinking?: unknown
}

function canonical(value: unknown, normalizeText: boolean): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown
      try { parsed = JSON.parse(trimmed) } catch { /* plain text */ }
      if (parsed !== undefined) {
        if (!safeCacheValue(parsed)) throw new Error("Secret-bearing JSON cannot be cached")
        return JSON.stringify(canonical(parsed, false))
      }
    }
    return normalizeText ? trimmed.replace(/\s+/gu, " ") : value
  }
  if (Array.isArray(value)) return value.map(item => canonical(item, normalizeText))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item, normalizeText && (typeof item === "string"
        ? ["content", "text", "description", "system", "input", "arguments"].includes(key)
        : !["parameters", "inputSchema", "input", "arguments"].includes(key)))]))
  }
  return value
}

/** No credentials enter the signature. Unsupported/side-effecting requests bypass. */
export function normalizePromptForCache(messages: unknown, options: CacheKeyOptions = {}): string | null {
  if (options.cache === false || (options.temperature !== 0 && options.cache !== true)) return null
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (key.toLowerCase() === "x-mik-no-cache" && value.trim().toLowerCase() === "true") return null
    if (!["x-mik-no-cache", "x-mik-model-tier"].includes(key.toLowerCase())) return null
  }
  const supportedMessages = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(supportedMessages)
    if (value && typeof value === "object") return Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every(supportedMessages)
    return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)
  }
  if (!supportedMessages(messages)) return null
  const tools = options.tools
  if (tools && typeof tools === "object" && Object.values(tools).some(tool => tool && typeof tool === "object" && typeof (tool as Record<string, unknown>).execute === "function")) return null
  const input = { messages, model: options.model, system: options.system, tools,
    temperature: options.temperature, maxTokens: options.maxTokens, batch: options.batch,
    reasoning_effort: options.reasoning_effort, reasoning: options.reasoning, thinking: options.thinking }
  try {
    let normalizedTools = canonical(tools, true)
    if (Array.isArray(normalizedTools)) normalizedTools = normalizedTools.sort((a, b) => {
      const left = JSON.stringify(a), right = JSON.stringify(b)
      return left < right ? -1 : left > right ? 1 : 0
    })
    const payload = JSON.stringify({ ...canonical(input, true) as Record<string, unknown>, tools: normalizedTools })
    // Refuse secret-bearing prompts rather than merging them under a redacted key.
    if (redact(payload) !== payload || JSON.stringify(redactDeep(JSON.parse(payload), 0, 64)) !== payload) return null
    return createHash("sha256").update(payload).digest("hex")
  } catch { return null }
}

export function safeCacheValue(value: unknown): boolean {
  const text = JSON.stringify(value)
  return text === JSON.stringify(redactDeep(value, 0, 64)) && redact(text) === text
}
