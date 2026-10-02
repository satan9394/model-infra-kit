import assert from "node:assert/strict"
import test from "node:test"
import { traceTimeline } from "../lib/trace-timeline.ts"
import type { UsageEvent } from "../lib/types.ts"

const event: UsageEvent = { requestId: "a", appId: "test", ts: 100, source: "stream", providerId: "p", modelRequested: "m", modelActual: "m", usage: { input: 10, output: 10, reasoning: 4, cacheRead: 0, cacheWrite: 0 }, cost: { usd: 0, low: 0, high: 0, source: "missing", basis: "flat" }, latencyMs: 100, firstTokenMs: 20, status: "ok", isStreaming: true }
test("waterfall spans include request ends and preserve overlapping calls", () => {
  const rows = traceTimeline([{ ...event, requestId: "b", ts: 150 }, event])
  assert.ok(rows[0] && rows[1])
  assert.equal(rows[0].left, 0)
  assert.equal(rows[0].spanMs, 150)
  assert.ok(Math.abs(rows[1].left + rows[1].width - 100) < 1e-10)
  assert.ok(rows[0].width > rows[1].left)
  assert.equal(rows[0].ttft, 20)
  assert.equal(rows[0].reasoning, 32)
  assert.equal(rows[0].output, 48)
})
test("missing timings and excess reasoning counts cannot overflow", () => {
  const rows = traceTimeline([{ ...event, firstTokenMs: 200, usage: { ...event.usage, reasoning: 100 } }, { ...event, latencyMs: undefined }])
  assert.ok(rows[0] && rows[1])
  assert.equal(rows[0].ttft, 100)
  assert.equal(rows[0].reasoning, 0)
  assert.equal(rows[1].width, 0)
  assert.deepEqual(traceTimeline([]), [])
})

test("tool execution bars align with overlapping requests and clamp to the parent", () => {
  const tool = { tool_name: "lookup", id: "tool-a", input_hash: "a".repeat(64), start_offset_ms: 20, duration_ms: 30, input_tokens: 6, output_tokens: 3, cost_micros: 4 }
  const rows = traceTimeline([{ ...event, tool_calls: [tool] }, { ...event, requestId: "b", ts: 150, tool_calls: [{ ...tool, start_offset_ms: 90, duration_ms: 50 }] }])
  assert.equal(rows[0]?.tools[0]?.left, 20 / 150 * 100)
  assert.equal(rows[0]?.tools[0]?.width, 30 / 150 * 100)
  assert.equal(rows[1]?.tools[0]?.width, 10 / 150 * 100)
  assert.equal(rows[1]?.tools[0]?.left, 140 / 150 * 100)
  assert.equal(rows[0]?.tools[0]?.call.input_hash, tool.input_hash)
  assert.equal(rows[0]?.tools[0]?.sharePercent, "0.00%")
  assert.equal(traceTimeline([{ ...event, cost: { ...event.cost, usd: 0.000010 }, tool_calls: [tool] }])[0]?.tools[0]?.sharePercent, "40.00%")
  assert.deepEqual(traceTimeline([event])[0]?.tools, [])
})
