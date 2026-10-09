import { ModelInfraError } from "../errors.js"
import { estimateContextTokens } from "../ai/smart-router.js"

export interface CascadingPolicy {
  tier1FastModel: string
  tier2ReasoningModel: string
  rules?: {
    maxPromptTokensForTier1?: number
    maxPromptCharsForTier1?: number
    reasoningKeywords?: string[]
    minToolCountForTier2?: number
    minConversationTurnsForTier2?: number
  }
}
export type CascadingConfig = Record<string, CascadingPolicy>
export type CascadingTier = "tier1" | "tier2"
export interface ComplexityRequest {
  system?: string
  messages?: readonly { role?: string; content?: unknown }[]
  input?: unknown
  tools?: unknown
  headers?: Record<string, string>
  reasoning_effort?: unknown
  reasoning?: unknown
  thinking?: unknown
}
const keywords = ["证明", "推导", "逐步", "重构", "算法复杂度", "step by step", "prove", "derive", "refactor", "algorithm complexity"]

/** Explicit intent wins before any prompt inspection. No I/O or request mutation. */
export function evaluateComplexity(request: ComplexityRequest, policy: CascadingPolicy): CascadingTier {
  if (request.reasoning_effort !== undefined || request.reasoning !== undefined || request.thinking !== undefined
    || Object.entries(request.headers ?? {}).some(([key, value]) => key.toLowerCase() === "x-mik-model-tier" && value.toLowerCase() === "reasoning")) return "tier2"
  const rules = policy.rules
  const tools = request.tools
  const toolCount = Array.isArray(tools) ? tools.length : tools && typeof tools === "object" ? Object.keys(tools).length : 0
  const messages = request.messages ?? (Array.isArray(request.input) ? request.input : [])
  if (messages.length > 128) return "tier2"
  if (toolCount >= (rules?.minToolCountForTier2 ?? 4)
    || messages.filter(message => message?.role === "user").length >= (rules?.minConversationTurnsForTier2 ?? 8)) return "tier2"
  // Conservative hard bounds keep arbitrary embedded requests within local heuristic work limits.
  const maxChars = Math.min(rules?.maxPromptCharsForTier1 ?? 16_000, 16_000)
  const maxTokens = rules?.maxPromptTokensForTier1 ?? 4_000
  let chars = 0
  let tokens = messages.length * 4
  const words = rules?.reasoningKeywords ?? keywords
  const inspect = (value: unknown, depth = 0): boolean => {
    if (depth > 6) return true
    if (typeof value === "string") {
      chars += value.length
      if (chars > maxChars) return true
      tokens += estimateContextTokens(value)
      const lower = value.toLowerCase()
      return tokens > maxTokens || words.some(word => lower.includes(word.toLowerCase()))
    }
    if (Array.isArray(value)) {
      if (value.length > 128) return true
      return value.some(part => inspect(part?.text ?? (part?.type === "tool-call" ? part.input : part?.type === "tool-result" ? part.output : undefined), depth + 1))
    }
    if (value && typeof value === "object") {
      let keys = 0
      for (const key in value) if (Object.hasOwn(value, key)) {
        if (++keys > 128 || inspect(key, depth + 1) || inspect((value as Record<string, unknown>)[key], depth + 1)) return true
      }
    }
    return false
  }
  if (tokens > maxTokens || inspect(request.system) || inspect(typeof request.input === "string" ? request.input : undefined)
    || messages.some(message => inspect(message?.content))) return "tier2"
  // ponytail: media has no guessed tokens; this is a bounded text heuristic.
  return "tier1"
}

/** Reject cycles, malformed targets and unbounded rules without echoing config. */
export function readCascadingConfig(value: unknown): CascadingConfig {
  const invalid = (): never => { throw new ModelInfraError("Invalid cascading configuration.", { code: "INVALID_REQUEST" }) }
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  if (!object(value) || Object.keys(value).length > 128) invalid()
  const result: CascadingConfig = Object.create(null)
  for (const [alias, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(alias) || !object(raw) || Object.keys(raw).some(key => !["tier1FastModel", "tier2ReasoningModel", "rules"].includes(key))) invalid()
    const p = raw as Record<string, unknown>
    for (const target of [p.tier1FastModel, p.tier2ReasoningModel]) if (typeof target !== "string" || target.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(target)) invalid()
    if (p.tier1FastModel === p.tier2ReasoningModel) invalid()
    if (p.rules !== undefined) {
      if (!object(p.rules)) invalid()
      for (const [key, rule] of Object.entries(p.rules as Record<string, unknown>)) {
        if (key === "reasoningKeywords") {
          if (!Array.isArray(rule) || rule.length > 64 || rule.some(word => typeof word !== "string" || !word.trim() || word.length > 128)) invalid()
        } else if (!["maxPromptTokensForTier1", "maxPromptCharsForTier1", "minToolCountForTier2", "minConversationTurnsForTier2"].includes(key) || !Number.isSafeInteger(rule) || (rule as number) < 1 || (rule as number) > 1_000_000) invalid()
      }
    }
    result[alias] = { tier1FastModel: p.tier1FastModel as string, tier2ReasoningModel: p.tier2ReasoningModel as string,
      ...(p.rules === undefined ? {} : { rules: { ...p.rules as CascadingPolicy["rules"], ...(Array.isArray((p.rules as Record<string, unknown>).reasoningKeywords) ? { reasoningKeywords: [...(p.rules as Record<string, unknown>).reasoningKeywords as string[]] } : {}) } }) }
  }
  return result
}
