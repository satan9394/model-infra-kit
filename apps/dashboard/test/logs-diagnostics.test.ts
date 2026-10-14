import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import * as diagnostics from "../lib/diagnostics.ts"
import { traceTimeline } from "../lib/trace-timeline.ts"
import * as format from "../lib/format.ts"
import { translator } from "../lib/i18n/core.ts"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"
import type { TraceTreeNode, UsageEvent } from "../lib/types.ts"

const require = createRequire(import.meta.url)
const row = (id: string, extra: Partial<UsageEvent> = {}): UsageEvent => ({ requestId: id, appId: "app", traceId: "shared", ts: 100,
  source: "generate", providerId: "primary", modelRequested: "m", modelActual: "m", status: "error", errorCode: "RATE_LIMIT",
  usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usd: 0, low: 0, high: 0, source: "missing", basis: "exact" }, isStreaming: false, ...extra })

for (const [code, status, expected] of [
  ["RATE_LIMIT", undefined, "rate_limit"], ["TIMEOUT", undefined, "timeout"], ["ENOTFOUND", undefined, "connection"],
  ["PROVIDER", 503, "provider_5xx"], ["AUTH", undefined, "terminal_4xx"], ["BUDGET_EXCEEDED", undefined, "budget_exceeded"],
  ["ABORTED", undefined, "cancelled"], ["UNKNOWN", undefined, "other"], ["TIMEOUT", 401, "terminal_4xx"],
  ["RATE_LIMIT", 422, "terminal_4xx"], ["PROVIDER", 504, "timeout"], ["INVALID_REQUEST", 429, "rate_limit"],
] as const) test(`structured classification ${code}/${status} -> ${expected}`, () => assert.equal(diagnostics.classifyFailure(code, status), expected))

test("shared traces and separate apps never merge logical calls; page groups preserve attempt order", () => {
  const events = [row("a2", { tags: { _mik_logical_request_id: "a", _mik_attempt_number: "2" } }),
    row("b"), row("a1", { tags: { _mik_logical_request_id: "a", _mik_attempt_number: "1" } }), row("c"),
    row("foreign", { appId: "other", tags: { _mik_logical_request_id: "a" } })]
  assert.deepEqual(diagnostics.logicalGroups(events).map(group => group.map(event => event.requestId)), [["a1", "a2"], ["b"], ["c"], ["foreign"]])
  assert.equal(diagnostics.logicalId(row("external", { source: "report", tags: { _mik_logical_request_id: "a" } })), undefined)
})

test("unknown duration remains unknown; malformed metadata cannot create negative bars", () => {
  assert.equal(diagnostics.attemptDuration(row("old", { latencyMs: 999 })), undefined)
  for (const value of ["NaN", "Infinity", "-1"]) assert.equal(diagnostics.attemptDuration(row("a", { tags: { _mik_attempt_duration_ms: value } })), undefined)
  assert.equal(diagnostics.attemptDuration(row("zero", { tags: { _mik_attempt_duration_ms: "0" } })), 0)
  assert.equal(diagnostics.attemptNumber(row("a", { tags: { _mik_attempt_number: "-8" } })), 1)
})

test("tree requires real edges; missing, partial, duplicate, orphan and cycle graphs degrade", () => {
  const root = row("root", { spanId: "root" })
  const child = row("child", { spanId: "child", parentSpanId: "root" })
  assert.equal(diagnostics.hasTraceTopology([root, child]), true)
  for (const events of [[], [root], [root, row("loose")], [root, child, row("loose")], [root, { ...child, parentSpanId: "absent" }],
    [root, { ...child, spanId: "root" }], [{ ...root, parentSpanId: "child" }, child], [root, { ...child, parentSpanId: "child" }]]) {
    assert.equal(diagnostics.hasTraceTopology(events), false)
  }
})

function load(lang: "en" | "zh") {
  const source = readFileSync(new URL("../components/execution-diagnostics.tsx", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  const exports: Record<string, any> = {}
  new Function("exports", "require", compiled)(exports, (name: string) => name === "@/lib/i18n/provider" ? { useI18n: () => ({ t: translator(lang) }) }
    : name === "@/lib/diagnostics" ? diagnostics : name === "@/lib/format" ? format
    : name === "@/components/ui" ? { Badge: ({ children }: any) => React.createElement("span", {}, children) } : require(name))
  return exports
}
for (const lang of ["en", "zh"] as const) {
  test(`attempt diagnostics render statuses, durations, safe reasons and navigation (${lang})`, () => {
    const { ExecutionDiagnostics } = load(lang)
    const events = [row("first", { tags: { _mik_logical_request_id: "logical", _mik_attempt_number: "1", _mik_attempt_duration_ms: "10", Authorization: "Basic secret", arbitrary: "gateway-private" } }),
      row("second", { providerId: "backup", status: "ok", tags: { _mik_logical_request_id: "logical", _mik_attempt_number: "2", _mik_attempt_duration_ms: "30", _mik_fallback_reason: "Authorization: Bearer private-token" } })]
    const html = renderToStaticMarkup(React.createElement(ExecutionDiagnostics, { events, selectedId: "second", partial: true, onSelect: () => {} }))
    assert.match(html, /attempt-sequence-view/)
    assert.match(html, /log-error-class/)
    assert.match(html, /aria-current="step"/)
    assert.match(html, /width:25%/)
    assert.match(html, /width:75%/)
    assert.ok(html.includes(translator(lang)("diagnostics.partial")))
    assert.ok(html.includes(translator(lang)("diagnostics.attempt", 2)))
    assert.doesNotMatch(html, /gateway-private|private-token|Basic secret|Authorization/)
    let selected = ""
    const tree = ExecutionDiagnostics({ events, selectedId: "first", partial: false, onSelect: (id: string) => { selected = id } })
    function nodes(element: any): any[] { return !element || typeof element !== "object" ? [] : [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)] }
    nodes(tree).filter(node => node.type === "button")[1].props.onClick()
    assert.equal(selected, "second")
  })
}

test("new dictionaries preserve parity and placeholder contracts", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(en).filter(key => key.startsWith("diagnostics.")) as (keyof typeof en)[]) {
    assert.deepEqual(en[key].match(/\{\d+\}/g), zh[key].match(/\{\d+\}/g))
  }
})


test("filtered valid spans cannot authorize an unfiltered or mismatched tree", () => {
  const root = row("root", { spanId: "root" })
  const child = row("child", { spanId: "child", parentSpanId: "root" })
  const node = (event: UsageEvent): TraceTreeNode => ({ spanId: event.spanId ?? event.requestId, requestId: event.requestId, parentSpanId: event.parentSpanId,
    spanType: "generation", stepIndex: 0, status: "ok", startedAt: 0, endedAt: 0, durationMs: 0, startOffsetMs: 0,
    stepCostMicros: 0, stepCacheSavingsMicros: 0, totalCostMicros: 0, usage: event.usage, children: [] })
  const tree = { ...node(root), spanId: "__trace_root__", requestId: undefined, children: [{ ...node(root), children: [node(child)] }] }
  assert.equal(diagnostics.canRenderTraceTree([root, child], tree), true)
  assert.equal(diagnostics.canRenderTraceTree([root, child], { ...tree, children: [...tree.children, node(row("outside-filter"))] }), false)
  assert.equal(diagnostics.canRenderTraceTree([root, child], { ...tree, children: [node(root), { ...node(child), parentSpanId: "other" }] }), false)
})


test("structured server errors and safe fallback classes preserve evidence without guessing PROVIDER", () => {
  assert.equal(diagnostics.classifyFailure("PROVIDER"), "other")
  assert.equal(diagnostics.classifyFailure("PROVIDER", undefined, "server_error"), "provider_5xx")
  assert.equal(diagnostics.classifyFailure("PROVIDER", 401, "server_error"), "terminal_4xx")
  assert.equal(diagnostics.fallbackReason(row("a", { tags: { _mik_fallback_reason: "PROVIDER", _mik_fallback_class: "provider_5xx" } })), "diagnostics.error.provider_5xx")
})


test("timeline uses measured attempts instead of cumulative request latency", () => {
  const first = row("first", { latencyMs: 900, tags: { _mik_attempt_started_at: "100", _mik_attempt_duration_ms: "10" } })
  const next = row("next", { latencyMs: 1200, tags: { _mik_attempt_started_at: "120", _mik_attempt_duration_ms: "30" } })
  const rows = traceTimeline([next, first])
  assert.equal(rows[0]!.event.requestId, "first")
  assert.equal(rows[0]!.spanMs, 50)
  assert.equal(rows[0]!.width, 20)
  assert.equal(rows[1]!.left, 40)
  assert.equal(rows[1]!.width, 60)
  assert.equal(first.latencyMs, 900)
})


test("attempt projection adjusts logical tool offsets and streaming TTFT but preserves generate TTFT", () => {
  const event = row("stream", { isStreaming: true, firstTokenMs: 25, latencyMs: 50,
    tags: { _mik_attempt_started_at: "120", _mik_attempt_duration_ms: "30" },
    tool_calls: [{ tool_name: "lookup", id: "tool", input_hash: "hash", start_offset_ms: 25, duration_ms: 5, input_tokens: 1, output_tokens: 1, cost_micros: 0 }] })
  const stream = traceTimeline([event])[0]!
  assert.equal(stream.event.firstTokenMs, 5)
  assert.equal(stream.tools[0]!.left, 5 / 30 * 100)
  assert.equal(stream.event.tool_calls![0]!.start_offset_ms, 5)
  assert.equal(traceTimeline([{ ...event, isStreaming: false }])[0]!.event.firstTokenMs, 25)
  assert.equal(event.firstTokenMs, 25)
  assert.equal(event.tool_calls![0]!.start_offset_ms, 25)
})
