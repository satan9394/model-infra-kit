import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import ts from "typescript"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { translator } from "../lib/i18n/core.ts"
import * as format from "../lib/format.ts"
import type { TraceTreeNode } from "../lib/types.ts"

const require = createRequire(import.meta.url)
const node: TraceTreeNode = { spanId: "tool", spanType: "tool_call", toolName: "lookup", stepIndex: 1, status: "ok", startedAt: 100, endedAt: 110, durationMs: 10, stepDurationMs: 3, firstTokenMs: 2, startOffsetMs: 0, stepCostMicros: 7, stepCacheSavingsMicros: 5, totalCostMicros: 7, usage: { input: 11, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, cascadingTier: "tier2", cascadingEscalated: true, children: [] }
const tree: TraceTreeNode = { ...node, spanId: "root", toolName: undefined, spanType: "root", stepCostMicros: 0, children: [node] }
function load(lang: "en" | "zh", react = React) {
  const source = readFileSync(new URL("../components/trace-tree.tsx", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  const exports: Record<string, any> = {}
  new Function("exports", "require", compiled)(exports, (name: string) => name === "react" ? react : name === "@/lib/i18n/provider" ? { useI18n: () => ({ t: translator(lang) }) } : name === "@/lib/format" ? format : require(name))
  return exports
}
for (const lang of ["en", "zh"] as const) {
  test(`execution tree renders nested tools and aligned timeline in ${lang}`, () => {
    const { TraceTreeView } = load(lang)
    const html = renderToStaticMarkup(React.createElement(TraceTreeView, { tree }))
    assert.ok(html.includes('data-testid="trace-execution-tree"'))
    assert.equal((html.match(/data-testid="trace-tree-node"/g) ?? []).length, 2)
    assert.ok(html.includes("lookup"))
    assert.ok(html.includes("left:0%;width:100%"))
    assert.ok(html.includes(translator(lang)("tree.tool_call")))
    assert.ok(html.includes("<details open="))
  })
  test(`inspector shows exclusive integer cost, cache, tokens, latency and cascade in ${lang}`, () => {
    const { StepCostInspector } = load(lang)
    const html = renderToStaticMarkup(React.createElement(StepCostInspector, { node, onClose: () => {} }))
    for (const key of ["tree.duration", "tree.firstToken", "tree.cost", "tree.savings", "tree.input", "tree.output", "tree.cacheRead", "tree.cacheWrite", "tree.reasoningTokens", "cascade.tier2", "cascade.escalated"]) assert.ok(html.includes(translator(lang)(key)))
    assert.ok(html.includes('role="dialog"'))
    assert.ok(html.includes('aria-modal="false"'))
    assert.ok(html.includes("3ms"))
    assert.ok(html.includes(">7</dd>"))
    assert.ok(html.includes('data-testid="step-cost-inspector"'))
  })
}
test("node click opens the inspector; close and Escape restore trigger focus", () => {
  let selected: TraceTreeNode | null = null
  const ref = { current: null as { focus: () => void } | null }
  let focusCount = 0
  const components = load("en", { ...React, useState: () => [selected, (value: TraceTreeNode | null) => { selected = value }], useRef: () => ref } as any)
  function elements(element: any): any[] {
    if (!element || typeof element !== "object") return []
    return [element, ...React.Children.toArray(element.props?.children).flatMap(elements)]
  }
  const rendered = components.TraceTreeView({ tree })
  const button = elements(rendered).find(item => item.type === "button" && item.props["aria-label"].endsWith("lookup"))
  button.props.onClick({ currentTarget: { focus: () => { focusCount++ } } })
  assert.equal(selected, node)
  const open = components.TraceTreeView({ tree })
  const inspector = elements(open).find(item => item.type === components.StepCostInspector)
  const drawer = components.StepCostInspector(inspector.props)
  drawer.props.onKeyDown({ key: "Escape" })
  assert.equal(selected, null)
  assert.equal(focusCount, 1)
  button.props.onClick({ currentTarget: ref.current })
  elements(drawer).find(item => item.type === "button").props.onClick()
  assert.equal(selected, null)
  assert.equal(focusCount, 2)
})
