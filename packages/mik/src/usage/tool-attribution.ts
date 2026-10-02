import { createHash } from "node:crypto"
import type { TokenUsage, ToolCallAttribution } from "../types.js"
import { redact } from "../util/redact.js"

const safeCount = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0

/** Convert the compatibility USD boundary to micros using decimal text, not binary multiplication. */
export function requestCostMicrosBigInt(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) return 0n
  const [coefficient = "0", exponent = "0"] = String(usd).split("e")
  const [whole = "0", fraction = ""] = coefficient.split(".")
  const power = Number(exponent) - fraction.length + 6
  const digits = BigInt(whole + fraction)
  const divisor = power < 0 ? 10n ** BigInt(-power) : 1n
  return power < 0 ? (digits + divisor / 2n) / divisor : digits * 10n ** BigInt(power)
}

/** Tool fields are safe integers; cap the attribution budget, never the billed total. */
export function requestCostMicros(usd: number): number {
  const micros = requestCostMicrosBigInt(usd)
  return Number(micros > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : micros)
}

/** Whitelist structured fields on write AND read, including hostile legacy JSON. */
export function sanitizeToolCalls(value: unknown, totalMicros: number): ToolCallAttribution[] | undefined {
  if (!Array.isArray(value)) return undefined
  let remaining = BigInt(safeCount(totalMicros))
  const calls: ToolCallAttribution[] = []
  for (const entry of value.slice(0, 256)) {
    if (!entry || typeof entry !== "object") continue
    const call = entry as Partial<ToolCallAttribution>
    if (typeof call.tool_name !== "string" || typeof call.id !== "string" || typeof call.input_hash !== "string" || !/^[a-f0-9]{64}$/.test(call.input_hash)) continue
    const cost = BigInt(safeCount(call.cost_micros))
    const bounded = cost > remaining ? remaining : cost
    remaining -= bounded
    calls.push({
      tool_name: redact(call.tool_name).replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 128),
      id: redact(call.id).replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 128),
      input_hash: call.input_hash,
      start_offset_ms: safeCount(call.start_offset_ms), duration_ms: safeCount(call.duration_ms),
      input_tokens: safeCount(call.input_tokens), output_tokens: safeCount(call.output_tokens), cost_micros: Number(bounded),
    })
  }
  return calls.length ? calls : undefined
}

/** Floor proportional shares; unassigned remainder and non-tool steps stay on the parent. */
export function allocateToolCosts(calls: ToolCallAttribution[], totalMicros: number, usage: Pick<TokenUsage, "input" | "output">): ToolCallAttribution[] {
  let denominator = BigInt(safeCount(usage.input)) + BigInt(safeCount(usage.output))
  const weights = calls.map(call => BigInt(safeCount(call.input_tokens)) + BigInt(safeCount(call.output_tokens)))
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (sum > denominator) denominator = sum
  return calls.map((call, index) => ({ ...call, cost_micros: denominator ? Number(BigInt(safeCount(totalMicros)) * weights[index]! / denominator) : 0 }))
}

/** Native SDK callbacks measure execute time without replacing host tool functions. */
export class ToolTraceCollector {
  private readonly calls: ToolCallAttribution[] = []
  private assignedCount = 0
  constructor(private readonly startedAt: number) {}

  start(event: { toolCall: { toolCallId: string; toolName: string; input: unknown } }): void {
    if (this.calls.length >= 256) return
    let serialized: string
    try { serialized = JSON.stringify(event.toolCall.input) ?? "null" } catch { serialized = "unserializable" }
    this.calls.push({ tool_name: event.toolCall.toolName, id: event.toolCall.toolCallId,
      input_hash: createHash("sha256").update(serialized).digest("hex"),
      start_offset_ms: Math.max(0, Date.now() - this.startedAt), duration_ms: 0,
      input_tokens: 0, output_tokens: 0, cost_micros: 0 })
  }

  end(event: { toolCall: { toolCallId: string }; toolExecutionMs: number }): void {
    const call = this.calls.findLast(item => item.id === event.toolCall.toolCallId)
    if (call) call.duration_ms = Math.max(0, Math.round(event.toolExecutionMs))
  }

  step(step: { toolCalls: readonly { toolCallId: string }[]; usage: { inputTokens?: number; outputTokens?: number } }): void {
    const ids = new Set(step.toolCalls.map(call => call.toolCallId))
    const calls = this.calls.slice(this.assignedCount).filter(call => ids.has(call.id))
    this.assignedCount = this.calls.length
    // ponytail: SDK reports step tokens, not tool tokens. Equal deterministic split,
    // preserving the step total, is attribution only and makes no per-tool billing claim.
    for (const [key, total] of [["input_tokens", safeCount(step.usage.inputTokens)], ["output_tokens", safeCount(step.usage.outputTokens)]] as const) {
      calls.forEach((call, i) => { call[key] = Math.floor(total / calls.length) + (i < total % calls.length ? 1 : 0) })
    }
  }

  finish(totalMicros: number, usage: TokenUsage): ToolCallAttribution[] | undefined {
    return sanitizeToolCalls(allocateToolCosts(this.calls, totalMicros, usage), totalMicros)
  }
}
