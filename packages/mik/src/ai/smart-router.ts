import type { ModelMessage } from "ai"
import { ModelInfraError } from "../errors.js"

export interface RouterRule {
  condition: string
  target: string
}
export interface RouterPolicy {
  rules: RouterRule[]
  default_target: string
}
export interface RouterConfig {
  aliases: Record<string, RouterPolicy>
}

/** Heuristic only: CJK code points count as one, other characters as 1/4. */
export function estimateContextTokens(text: string): number {
  let quarters = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    quarters += (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) ? 4 : 1
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      quarters += 3
      i += 1
    }
  }
  return Math.ceil(quarters / 4)
}

function invalid(): never {
  // Configuration text can contain credentials; never echo it in errors.
  throw new ModelInfraError("Invalid smart router configuration.", { code: "INVALID_REQUEST" })
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function target(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._:/-]*)?$/.test(value)
}

/** Validate JSON configuration without evaluating user expressions. */
export function readRouterConfig(value: unknown): RouterConfig {
  if (!object(value) || Object.keys(value).some(key => key !== "aliases") || !object(value.aliases)) invalid()
  const aliases: Record<string, RouterPolicy> = Object.create(null)
  const entries = Object.entries(value.aliases)
  if (entries.length > 128) invalid()
  for (const [alias, policy] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(alias) || !object(policy) || Object.keys(policy).some(key => !["rules", "default_target"].includes(key)) || !target(policy.default_target) || !Array.isArray(policy.rules) || policy.rules.length > 128) invalid()
    const rules: RouterRule[] = policy.rules.map(rule => {
      if (!object(rule) || Object.keys(rule).some(key => !["condition", "target"].includes(key)) || !target(rule.target) || typeof rule.condition !== "string" || rule.condition.length > 80) invalid()
      const parsed = /^context_tokens\s*(>=|<=|>|<|==)\s*(0|[1-9][0-9]*)$/.exec(rule.condition)
      if (!parsed || !Number.isSafeInteger(Number(parsed[2]))) invalid()
      return { condition: rule.condition, target: rule.target }
    })
    aliases[alias] = { rules, default_target: policy.default_target }
  }
  for (const policy of Object.values(aliases)) {
    if (Object.hasOwn(aliases, policy.default_target) || policy.rules.some(rule => Object.hasOwn(aliases, rule.target))) invalid()
  }
  return { aliases }
}

export class SmartRouter {
  private readonly aliases: Map<string, { default_target: string; rules: Array<RouterRule & { test: (tokens: number) => boolean }> }>
  constructor(config: RouterConfig) {
    this.aliases = new Map(Object.entries(readRouterConfig(config).aliases).map(([alias, policy]) => [alias, {
      default_target: policy.default_target,
      rules: policy.rules.map(rule => {
        const parsed = /^context_tokens\s*(>=|<=|>|<|==)\s*(\d+)$/.exec(rule.condition)!
        const threshold = Number(parsed[2])
        const tests: Record<string, (tokens: number) => boolean> = {
          ">": n => n > threshold, "<": n => n < threshold,
          ">=": n => n >= threshold, "<=": n => n <= threshold, "==": n => n === threshold,
        }
        return { ...rule, test: tests[parsed[1]!]! }
      }),
    }]))
  }
  select(request: { model?: string; system?: string; messages: readonly ModelMessage[] }): { target: string; tags: Record<string, string> } | undefined {
    const alias = request.model?.trim()
    // Literal physical refs and unrelated bare IDs never inspect prompt content.
    if (!alias || alias.includes(":")) return undefined
    const policy = this.aliases.get(alias)
    if (!policy) return undefined
    let tokens = request.system ? estimateContextTokens(request.system) : 0
    for (const message of request.messages) {
      tokens += 4 // approximate message framing
      if (typeof message.content === "string") tokens += estimateContextTokens(message.content)
      else for (const part of message.content) {
        if (part.type === "text") tokens += estimateContextTokens(part.text)
        else if (part.type === "tool-call") tokens += estimateContextTokens(JSON.stringify(part.input) ?? "")
        else if (part.type === "tool-result") tokens += estimateContextTokens(JSON.stringify(part.output) ?? "")
        // ponytail: media has no guessed token count; only supplied text is estimated.
      }
    }
    const rule = policy.rules.find(rule => rule.test(tokens))
    return { target: rule?.target ?? policy.default_target, tags: { routing_rule: rule?.condition ?? "default_target", virtual_model: alias } }
  }
}
