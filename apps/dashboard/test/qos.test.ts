import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import ts from "typescript"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { translator } from "../lib/i18n/core.ts"
import type { EndpointQoSStats } from "../lib/qos.ts"

const require = createRequire(import.meta.url)
function component(lang: "en" | "zh") {
  const compiled = ts.transpileModule(readFileSync(new URL("../components/qos-status.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  const exports: Record<string, React.ComponentType<any>> = {}
  new Function("exports", "require", compiled)(exports, (name: string) => name === "@/lib/i18n/provider" ? { useI18n: () => ({ t: translator(lang) }) } : require(name))
  return exports.QoSStatus!
}
const sample: EndpointQoSStats = { providerId: "p", modelId: "model", sampleCount: 10, ewmaRttMs: 100, ewmaTtftMs: 50, jitterMs: 20, jitterVarianceMs2: 400, consecutiveFailures: 0, successRate: 0.9, qosScore: 85, effectiveWeight: 85, lastUpdated: 1000 }
for (const lang of ["en", "zh"] as const) {
  test(`QoS renders actual latency, jitter, success and weight in ${lang}`, () => {
    const QoSStatus = component(lang)
    const t = translator(lang)
    const html = renderToStaticMarkup(React.createElement(QoSStatus, { channels: [sample], now: 1000 }))
    for (const value of [t("qos.healthy"), t("qos.weight"), t("qos.rtt"), "100 ms", "50 ms", "20 ms", "90%", "85"]) assert.ok(html.includes(value), value)
    assert.match(html, /data-testid="qos-status"/)
    for (const [score, key] of [[60, "qos.variable"], [30, "qos.degraded"]] as const) assert.ok(renderToStaticMarkup(React.createElement(QoSStatus, { channels: [{ ...sample, qosScore: score }], now: 1000 })).includes(t(key)))
  })
  test(`QoS distinguishes stale, empty, missing TTFT and endpoint failure in ${lang}`, () => {
    const QoSStatus = component(lang)
    const t = translator(lang)
    for (const channels of [[], [{ ...sample, sampleCount: 0 }], [sample]]) {
      const html = renderToStaticMarkup(React.createElement(QoSStatus, { channels, now: 32000 }))
      assert.ok(html.includes(t("qos.waiting")))
      assert.ok(!html.includes(t("qos.healthy")))
    }
    assert.ok(renderToStaticMarkup(React.createElement(QoSStatus, { channels: [sample], unavailable: true })).includes(t("qos.unavailable")))
    assert.ok(renderToStaticMarkup(React.createElement(QoSStatus, { channels: [{ ...sample, ewmaTtftMs: null }], now: 1000 })).includes("—"))
  })
}
