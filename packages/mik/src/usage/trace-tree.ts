import type { SpanEventMetadata, TokenUsage, UsageEvent } from "../types.js"

export interface TraceTreeNode {
  spanId: string
  parentSpanId?: string
  spanType: NonNullable<SpanEventMetadata["spanType"]>
  stepIndex: number
  toolName?: string
  requestId?: string
  stepDurationMs?: number
  firstTokenMs?: number
  cascadingTier?: "tier1" | "tier2"
  cascadingEscalated?: boolean
  status: "ok" | "error" | "RATE_LIMITED"
  startedAt: number
  endedAt: number
  durationMs: number
  startOffsetMs: number
  stepCostMicros: number
  stepCacheSavingsMicros: number
  totalCostMicros: number
  usage: TokenUsage
  children: TraceTreeNode[]
}

const tokens = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
const integer = (value: number | undefined): number => {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Trace amounts must be non-negative safe integer micros")
  return value
}
const add = (a: number, b: number): number => integer(a + b)

/** Synchronous, no mutation or I/O. Exclusive step costs sum to the synthetic root total.
 * Tool attributions partition their owning request; they never add a second charge.
 * ponytail: absent retained rows cannot reconstruct archived topology.
 */
export function buildTraceTree(events: UsageEvent[]): TraceTreeNode {
  const root: TraceTreeNode = { spanId: "__trace_root__", spanType: "root", stepIndex: 0, status: "ok",
    startedAt: 0, endedAt: 0, durationMs: 0, startOffsetMs: 0, stepCostMicros: 0,
    stepCacheSavingsMicros: 0, totalCostMicros: 0, usage: tokens(), children: [] }
  if (!events.length) return root
  root.startedAt = events[0]!.ts
  for (const event of events) root.startedAt = Math.min(root.startedAt, event.ts)
  const byId = new Map<string, TraceTreeNode>()
  const nodes: TraceTreeNode[] = []
  for (const event of events) {
    const amount = event.costMicros ?? event.stepCostMicros
    if (amount === undefined) throw new RangeError("Trace events require authoritative integer micros")
    const cost = integer(amount)
    const id = event.spanId ?? event.requestId
    // Duplicate ids remain visible, but only the first can be a parent target.
    const node: TraceTreeNode = { spanId: id, parentSpanId: event.parentSpanId,
      spanType: event.spanType ?? "generation", stepIndex: event.stepIndex ?? 0, toolName: event.toolName,
      requestId: event.requestId, status: event.status, startedAt: event.ts,
      stepDurationMs: Math.max(0, event.latencyMs ?? 0),
      firstTokenMs: event.firstTokenMs,
      cascadingTier: event.tags?.cascading_tier === "tier1" || event.tags?.cascading_tier === "tier2" ? event.tags.cascading_tier : undefined,
      cascadingEscalated: event.tags?.cascading_escalated === "true",
      endedAt: event.ts + Math.max(0, event.latencyMs ?? 0), durationMs: Math.max(0, event.latencyMs ?? 0),
      startOffsetMs: event.ts - root.startedAt, stepCostMicros: cost,
      stepCacheSavingsMicros: integer(event.stepCacheSavingsMicros), totalCostMicros: cost,
      usage: { ...event.usage }, children: [] }
    let remaining = cost
    for (const [index, call] of (event.tool_calls ?? []).entries()) {
      const share = Math.min(remaining, integer(call.cost_micros))
      remaining -= share
      node.children.push({ spanId: `${event.requestId}:tool:${index}`, parentSpanId: id,
        spanType: "tool_call", stepIndex: index, toolName: call.tool_name, status: event.status,
        startedAt: event.ts + call.start_offset_ms, endedAt: event.ts + call.start_offset_ms + call.duration_ms,
        durationMs: call.duration_ms, startOffsetMs: event.ts + call.start_offset_ms - root.startedAt,
        stepCostMicros: share, stepCacheSavingsMicros: 0, totalCostMicros: share,
        usage: { ...tokens(), input: call.input_tokens, output: call.output_tokens }, children: [] })
    }
    node.stepCostMicros = remaining
    nodes.push(node)
    if (!byId.has(id)) byId.set(id, node)
    root.totalCostMicros = add(root.totalCostMicros, cost)
    root.endedAt = Math.max(root.endedAt, node.endedAt)
    if (event.status === "error") root.status = "error"
    for (const key of Object.keys(root.usage) as (keyof TokenUsage)[]) root.usage[key] += event.usage[key]
  }
  // Resolve the functional parent graph once; break cycles without recursive stack growth.
  const parents = new Map(nodes.map(node => [node, byId.get(node.parentSpanId ?? "")]))
  const done = new Set<TraceTreeNode>()
  for (const node of nodes) {
    if (done.has(node)) continue
    const parent = parents.get(node)
    if (!parent || done.has(parent)) { done.add(node); continue }
    const path = new Set<TraceTreeNode>()
    let current: TraceTreeNode | undefined = node
    while (current && !done.has(current)) {
      if (path.has(current)) { parents.set(current, undefined); break }
      path.add(current)
      current = parents.get(current)
    }
    for (const entry of path) done.add(entry)
  }
  for (const node of nodes) (parents.get(node) ?? root).children.push(node)
  const order = [root]
  for (let i = 0; i < order.length; i++) {
    const node = order[i]!
    node.children.sort((a, b) => a.stepIndex - b.stepIndex || a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId))
    order.push(...node.children)
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]!
    node.totalCostMicros = node.stepCostMicros
    for (const child of node.children) {
      node.totalCostMicros = add(node.totalCostMicros, child.totalCostMicros)
      node.endedAt = Math.max(node.endedAt, child.endedAt)
    }
    node.durationMs = Math.max(0, node.endedAt - node.startedAt)
  }
  return root
}
