import type { UsageEvent } from "./types.ts"
import { usdToMicros } from "./playground.ts"

export function traceTimeline(events: UsageEvent[]) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  const start = sorted[0]?.ts ?? 0
  const end = Math.max(start + 1, ...sorted.map((event) => event.ts + Math.max(0, event.latencyMs ?? 0)))
  return sorted.map((event) => {
    const duration = Math.max(0, event.latencyMs ?? 0)
    const ttft = Math.min(duration, Math.max(0, event.firstTokenMs ?? 0))
    // ponytail: token proportions estimate phases; the store has no reasoning timestamps.
    const remaining = duration - ttft
    const reasoning = remaining * Math.min(1, event.usage.reasoning / Math.max(1, event.usage.output))
    const tools = (event.tool_calls ?? []).map(call => {
      const offset = Math.min(duration, Math.max(0, call.start_offset_ms))
      const elapsed = Math.min(duration - offset, Math.max(0, call.duration_ms))
      const totalMicros = usdToMicros(event.cost.usd)
      const basisPoints = totalMicros ? BigInt(call.cost_micros) * 10_000n / BigInt(totalMicros) : 0n
      const sharePercent = `${basisPoints / 100n}.${String(basisPoints % 100n).padStart(2, "0")}%`
      return { call, sharePercent, left: (event.ts - start + offset) / (end - start) * 100, width: elapsed / (end - start) * 100 }
    })
    return { event, tools, spanMs: end - start, left: (event.ts - start) / (end - start) * 100, width: duration / (end - start) * 100,
      ttft: duration ? ttft / duration * 100 : 0, reasoning: duration ? reasoning / duration * 100 : 0,
      output: duration ? (remaining - reasoning) / duration * 100 : 0 }
  })
}
