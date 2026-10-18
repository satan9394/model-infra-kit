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

// ponytail: oversized/unsupported inputs bypass caching; generation remains available.
function boundedJson(value: unknown, schemas = false): boolean {
  let nodes = 0, characters = 0
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 4096 || depth > 32) return false
    if (typeof item === "string") { characters += item.length; return characters <= 65_536 }
    if (typeof item === "number") return Number.isFinite(item)
    if (item === undefined || item === null || typeof item === "boolean") return true
    if (!item || typeof item !== "object") return false
    if (Array.isArray(item)) {
      if (item.length > 4096) return false
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i)
        if (!descriptor || !("value" in descriptor) || descriptor.value === undefined || !visit(descriptor.value, depth + 1)) return false
      }
      return true
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) return false
    const keys = Object.keys(item)
    if (keys.length > 4096) return false
    for (const key of keys) {
      characters += key.length
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      // AI SDK jsonSchema() exposes its declarative schema through this getter.
      const sdkSchema = schemas && key === "jsonSchema"
        && Object.getOwnPropertyDescriptor(item, Symbol.for("vercel.ai.schema"))?.value === true
      if (characters > 65_536 || (!("value" in descriptor) && !sdkSchema)
        || !visit("value" in descriptor ? descriptor.value : descriptor.get?.call(item), depth + 1)) return false
    }
    return true
  }
  return visit(value, 0)
}

function canonical(value: unknown, normalizeText: boolean): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (normalizeText && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
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
  try {
    if (!boundedJson(messages)) return null
    if (options.cache === false || (options.temperature !== 0 && options.cache !== true)) return null
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (key.toLowerCase() === "x-mik-no-cache" && value.trim().toLowerCase() === "true") return null
      if (!["x-mik-no-cache", "x-mik-model-tier", "x-mik-approx-threshold"].includes(key.toLowerCase())) return null
    }
    const tools = options.tools
    if (tools && typeof tools === "object" && Object.values(tools).some(tool => tool && typeof tool === "object" && typeof (tool as Record<string, unknown>).execute === "function")) return null
    const input = { messages, model: options.model, system: options.system, tools,
      temperature: options.temperature, maxTokens: options.maxTokens, batch: options.batch,
      reasoning_effort: options.reasoning_effort, reasoning: options.reasoning, thinking: options.thinking }
    if (!boundedJson(input, true)) return null
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
  try {
    if (!boundedJson(value)) return false
    const text = JSON.stringify(value)
    return typeof text === "string" && text === JSON.stringify(redactDeep(value, 0, 64)) && redact(text) === text
  } catch { return false }
}
