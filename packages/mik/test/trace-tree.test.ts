import { expect, it } from "vitest"
import { buildTraceTree, type TraceTreeNode } from "../src/usage/trace-tree.js"
import type { UsageEvent } from "../src/types.js"

function event(id: string, parentSpanId?: string, stepIndex = 0, costMicros = 1): UsageEvent {
  return { requestId: id, spanId: id, parentSpanId, stepIndex, costMicros, appId: "test", ts: 100 + stepIndex,
    source: "test", providerId: "p", modelRequested: "m", modelActual: "m", status: "ok", isStreaming: false,
    usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, latencyMs: 5,
    cost: { usd: 999, low: 999, high: 999, basis: "manual", source: "manual" } }
}
function sum(root: TraceTreeNode): number {
  const queue = [root]
  let total = 0
  for (let i = 0; i < queue.length; i++) { total += queue[i]!.stepCostMicros; queue.push(...queue[i]!.children) }
  return total
}
it("builds deep out-of-order nesting without mutating inputs and uses integer columns", () => {
  const events = Array.from({ length: 1000 }, (_, i) => event(String(i), i ? String(i - 1) : undefined, i, 7)).reverse()
  const before = JSON.stringify(events)
  const tree = buildTraceTree(events)
  let node = tree.children[0]!
  for (let i = 0; i < 999; i++) node = node.children[0]!
  expect(node.spanId).toBe("999")
  expect(sum(tree)).toBe(7000)
  expect(tree.totalCostMicros).toBe(7000)
  expect(JSON.stringify(events)).toBe(before)
})
it("sorts parallel tools by step, then time, then id and aligns to one trace origin", () => {
  const tree = buildTraceTree([event("p"), event("b", "p", 2), event("a", "p", 2), event("early", "p", 1)])
  expect(tree.children[0]!.children.map(n => n.spanId)).toEqual(["early", "a", "b"])
  expect(tree.children[0]!.children.map(n => n.startOffsetMs)).toEqual([1, 2, 2])
  expect(tree.durationMs).toBe(7)
})
it("orphans, self cycles, mutual cycles and duplicate ids remain visible and conserved", () => {
  const tree = buildTraceTree([event("orphan", "missing"), event("self", "self"), event("a", "b"), event("b", "a"), event("a")])
  expect(sum(tree)).toBe(5)
  expect(tree.totalCostMicros).toBe(5)
})
it("tool attribution partitions a request and preserves integer residuals", () => {
  const call = event("call", undefined, 0, 11)
  call.tool_calls = ["a", "b"].map(id => ({ id, tool_name: id, input_hash: "a".repeat(64), start_offset_ms: 1, duration_ms: 2, input_tokens: 1, output_tokens: 1, cost_micros: 4 }))
  call.stepCacheSavingsMicros = 2
  const tree = buildTraceTree([call])
  expect(tree.children[0]!.stepCostMicros).toBe(3)
  expect(tree.children[0]!.stepCacheSavingsMicros).toBe(2)
  expect(sum(tree)).toBe(tree.totalCostMicros)
  expect(tree.totalCostMicros).toBe(11)
})
it("supports empty traces and rejects unsafe, fractional or overflowing amounts", () => {
  expect(buildTraceTree([]).totalCostMicros).toBe(0)
  expect(() => buildTraceTree([{ ...event("missing"), costMicros: undefined }])).toThrow()
  for (const cost of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => buildTraceTree([event("a", undefined, 0, cost)])).toThrow()
  expect(() => buildTraceTree([event("a", undefined, 0, Number.MAX_SAFE_INTEGER), event("b")])).toThrow()
})
it("builds a representative 200-span parallel trace in less than 2ms", () => {
  const events = Array.from({ length: 200 }, (_, i) => event(String(i), i ? "0" : undefined, i))
  for (let i = 0; i < 20; i++) buildTraceTree(events)
  const start = performance.now()
  const tree = buildTraceTree(events)
  const elapsed = performance.now() - start
  console.log(`EVO-G127 200-span build: ${elapsed.toFixed(6)}ms`)
  expect(tree.totalCostMicros).toBe(200)
  expect(elapsed).toBeLessThan(2)
})
