import type { TraceTreeNode, UsageEvent } from "./types.ts"
import { classifyFailure, type FailureClass } from "../../../packages/mik/src/util/error-classification.ts"

export { classifyFailure }
export type { FailureClass }
export const failureClasses: FailureClass[] = ["rate_limit", "timeout", "connection", "provider_5xx", "terminal_4xx", "budget_exceeded", "cancelled", "other"]

export function failureClass(event: UsageEvent): FailureClass | undefined {
  if (event.status === "ok") return undefined
  const recorded = event.tags?._mik_failure_class as FailureClass | undefined
  return recorded && failureClasses.includes(recorded) ? recorded : classifyFailure(event.errorCode)
}

export function logicalId(event: UsageEvent | undefined): string | undefined {
  return (event?.source === "generate" || event?.source === "stream") ? event.tags?._mik_logical_request_id : undefined
}

/** Page-local grouping only. traceId is deliberately never used as identity. */
export function logicalGroups(events: UsageEvent[]): UsageEvent[][] {
  const groups = new Map<string, UsageEvent[]>()
  for (const event of events) {
    const key = JSON.stringify([event.appId, logicalId(event) ?? event.requestId])
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  return [...groups.values()].map(group => group.sort((a, b) => attemptNumber(a) - attemptNumber(b) || a.ts - b.ts || a.requestId.localeCompare(b.requestId)))
}

export function attemptNumber(event: UsageEvent): number {
  const value = Number(event.tags?._mik_attempt_number)
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}

export function attemptDuration(event: UsageEvent): number | undefined {
  // Legacy latency includes preceding attempts; never call it per-attempt duration.
  const raw = event.tags?._mik_attempt_duration_ms
  const value = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

export function attemptStart(event: UsageEvent): number | undefined {
  const raw = event.tags?._mik_attempt_started_at
  const value = raw === undefined ? NaN : Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** One actual root, every other span resolves within this retained graph, no cycles. */
export function hasTraceTopology(events: UsageEvent[]): boolean {
  if (events.length < 2) return false
  const byId = new Map(events.map(event => [event.spanId ?? event.requestId, event]))
  if (byId.size !== events.length || events.filter(event => !event.parentSpanId).length !== 1) return false
  for (const event of events) {
    const seen = new Set<UsageEvent>()
    let node: UsageEvent | undefined = event
    while (node) {
      if (seen.has(node)) return false
      seen.add(node)
      if (!node.parentSpanId) break
      node = byId.get(node.parentSpanId)
      if (!node) return false
    }
  }
  return true
}

/** Tree endpoint is unfiltered: never authorize it using a different filtered graph. */
export function canRenderTraceTree(events: UsageEvent[], tree: TraceTreeNode): boolean {
  if (!hasTraceTopology(events)) return false
  const nodes: TraceTreeNode[] = []
  const pending = [tree]
  while (pending.length) {
    const node = pending.pop()!
    if (node.requestId) nodes.push(node)
    pending.push(...node.children)
  }
  if (nodes.length !== events.length) return false
  const byRequest = new Map(nodes.map(node => [node.requestId, node]))
  return byRequest.size === events.length && events.every(event => {
    const node = byRequest.get(event.requestId)
    return node?.spanId === (event.spanId ?? event.requestId) && node.parentSpanId === event.parentSpanId
  })
}

/** Allowlisted decisions only: never render arbitrary upstream text as a reason. */
export function fallbackReason(event: UsageEvent): string | undefined {
  const code = event.tags?._mik_fallback_reason ?? event.tags?.failover_reason
  if (!code) return undefined
  const category = event.tags?._mik_fallback_class as FailureClass | undefined
  if (category && failureClasses.includes(category)) return `diagnostics.error.${category}`
  return code === "CIRCUIT_OPEN" ? "diagnostics.circuitOpen" : `diagnostics.error.${classifyFailure(code)}`
}
