import assert from "node:assert/strict"
import test from "node:test"
import * as format from "../lib/format.ts"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import React from "react"
import ts from "typescript"
import { translator } from "../lib/i18n/core.ts"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"
const { formatUsd } = format

for (const value of [0.000001, 0.00003, 0.00034, 0.000654, -0.000001]) {
  test(`explicit chart precision keeps a real micro charge ${value}`, () => {
    assert.notEqual(formatUsd(value, 2), "$0.00")
    assert.equal(formatUsd(value, 2), formatUsd(value))
  })
}

test("cost accuracy fails closed for missing, folded and legacy coverage", () => {
  for (const summary of [null, {}, { costAccuracy: "exact" as const, unpricedRequests: 1 }, { costAccuracy: "exact" as const, unmeasuredRequests: 1 }]) assert.equal(format.costAccuracy(summary), "unknown")
  assert.equal(format.costAccuracy({ costAccuracy: "exact" }), "exact")
  assert.equal(format.costAccuracy({ costAccuracy: "estimate" }), "estimate")
})
test("price sources distinguish catalogue, override, archive and missing", () => {
  for (const source of ["manual", "override"]) assert.equal(format.pricingSource(source), "override")
  for (const source of ["modelsdev", "openrouter"]) assert.equal(format.pricingSource(source), "synced")
  assert.equal(format.pricingSource("fallback"), "archive")
  for (const source of [undefined, "missing", "provider"]) assert.equal(format.pricingSource(source), "unknown")
})
test("token output ratio has an explicit denominator and no invented zero", () => {
  assert.equal(format.outputInputRatio({ input: 100, output: 25 }), "25.0%")
  assert.equal(format.outputInputRatio({ input: 0, output: 25 }), "—")
})
test("fallback rate display retains cache-rate precision and real zero", () => {
  assert.equal(format.formatRate(0.0028), "$0.0028")
  assert.notEqual(format.formatRate(0.000001), "$0.000")
  assert.notEqual(format.formatRate(0.00000001), "$0.000")
  assert.equal(format.formatRate(0), "$0")
  assert.equal(format.formatRate(undefined), "—")
})
test("added dictionaries preserve all keys and placeholders", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(en) as (keyof typeof en)[]) assert.deepEqual(en[key].match(/\{\d+\}/g), zh[key].match(/\{\d+\}/g), key)
})

const require = createRequire(import.meta.url)
function harness(lang: "en" | "zh") {
  const source = readFileSync(new URL("../components/pricing-client.tsx", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  const states: any[] = []; let cursor = 0; let refreshes = 0
  const calls: any[] = []; let response = { ok: true, data: {} } as any
  const exports: any = {}
  const mockReact = { ...React, useState: (initial: any) => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], (next: any) => { states[index] = next }] } }
  new Function("exports", "require", compiled)(exports, (name: string) => name === "react" ? mockReact
    : name === "@/lib/i18n/provider" ? { useI18n: () => ({ t: translator(lang) }) }
    : name === "next/navigation" ? { useRouter: () => ({ refresh: () => { refreshes++ } }) }
    : name === "@/lib/client-api" ? { apiCall: async (...args: any[]) => { calls.push(args); return response } }
    : name === "@/lib/format" ? format : name === "@/components/ui" ? {} : require(name))
  const render = () => { cursor = 0; return exports.PricingClient({ state: null, models: [], overrides: [{ modelId: "unknown/model", inputPerM: 9, updatedAt: 1 }],
    prices: [{ modelId: "unknown/model", effective: { inputPerM: 9, source: "manual" }, baseline: { inputPerM: 0.14, outputPerM: 0.28, source: "fallback" } }] }) }
  function nodes(element: any): any[] { return !element || typeof element !== "object" ? [] : [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)] }
  return { render, nodes, calls, refreshes: () => refreshes, fail: () => { response = { ok: false, error: "denied" } } }
}
for (const lang of ["en", "zh"] as const) {
  test(`revoke requires a second click, cancellation writes nothing and fallback is explicit (${lang})`, async () => {
    const h = harness(lang)
    h.nodes(h.render()).find(n => n.props?.["data-testid"] === "revoke-btn").props.onClick()
    assert.equal(h.calls.length, 0)
    let tree = h.render()
    const text = h.nodes(tree).find(n => n.props?.role === "status").props.children
    assert.ok(text.includes("$0.140")); assert.ok(text.includes("$0.280")); assert.ok(text.includes(translator(lang)("price.source.archive")))
    h.nodes(tree).find(n => n.type === "button" && n.props.children === translator(lang)("price.cancel")).props.onClick()
    assert.equal(h.calls.length, 0)
    assert.equal(h.nodes(h.render()).some(n => n.props?.["data-testid"] === "revoke-confirm-btn"), false)
    h.nodes(h.render()).find(n => n.props?.["data-testid"] === "revoke-btn").props.onClick()
    await h.nodes(h.render()).find(n => n.props?.["data-testid"] === "revoke-confirm-btn").props.onClick()
    await Promise.resolve()
    assert.deepEqual(h.calls, [["/pricing/unknown%2Fmodel", { method: "DELETE" }]])
    assert.equal(h.refreshes(), 1)
  })
  test(`failed revoke keeps confirmation available and reports failure (${lang})`, async () => {
    const h = harness(lang); h.fail()
    h.nodes(h.render()).find(n => n.props?.["data-testid"] === "revoke-btn").props.onClick()
    await h.nodes(h.render()).find(n => n.props?.["data-testid"] === "revoke-confirm-btn").props.onClick(); await Promise.resolve()
    assert.equal(h.refreshes(), 0)
    assert.ok(h.nodes(h.render()).some(n => n.props?.["data-testid"] === "revoke-confirm-btn"))
    assert.ok(h.nodes(h.render()).some(n => n.props?.children === "denied"))
  })
}
