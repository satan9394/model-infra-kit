import type { UsageEvent } from "./types.ts"

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
    return { event, spanMs: end - start, left: (event.ts - start) / (end - start) * 100, width: duration / (end - start) * 100,
      ttft: duration ? ttft / duration * 100 : 0, reasoning: duration ? reasoning / duration * 100 : 0,
      output: duration ? (remaining - reasoning) / duration * 100 : 0 }
  })
}
