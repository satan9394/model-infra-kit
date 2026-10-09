import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import ts from "typescript"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { translator } from "../lib/i18n/core.ts"
import { traceTimeline } from "../lib/trace-timeline.ts"
import * as format from "../lib/format.ts"
import type { UsageEvent } from "../lib/types.ts"

const require = createRequire(import.meta.url)
function component(file: string, lang: "en" | "zh") {
  const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText
  const exports: Record<string, React.ComponentType<any>> = {}
  const resolve = (name: string) => {
    if (name === "@/lib/i18n/provider") return { useI18n: () => ({ t: translator(lang) }) }
    if (name === "@/lib/i18n/core") return { message: (key: string) => key }
    if (name === "@/lib/format") return format
    if (name === "@/lib/trace-timeline") return { traceTimeline }
    if (name === "@/components/ui") return {
      Badge: ({ children }: any) => React.createElement("span", null, children),
      Card: ({ title, children }: any) => React.createElement("section", null, title, children),
      EmptyState: () => null, TableWrap: ({ children }: any) => React.createElement("table", null, children),
    }
    if (name === "next/navigation") return { useRouter: () => ({}) }
    if (name === "@/lib/model-capabilities") return { CAPABILITY_FILTERS: [], matchesCapabilities: () => true }
    if (name.startsWith("@/")) return {}
    return require(name)
  }
  new Function("exports", "require", compiled)(exports, resolve)
  return exports
}
for (const lang of ["en", "zh"] as const) {
  test(`cascade trace badges render both tiers and escalation in ${lang}`, () => {
    const TraceWaterfall = component("trace-waterfall", lang).TraceWaterfall!
    const base: UsageEvent = { appId: "app", source: "test", modelRequested: "cascade", isStreaming: false, requestId: "fast", modelActual: "fast", providerId: "p", ts: 1, status: "ok", usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usd: 0, low: 0, high: 0, basis: "flat", source: "override" } }
    const events = [
      { ...base, tags: { cascading_tier: "tier1", cascading_escalated: "false" } },
      { ...base, requestId: "deep", tags: { cascading_tier: "tier2", cascading_escalated: "true" } },
    ] as UsageEvent[]
    const html = renderToStaticMarkup(React.createElement(TraceWaterfall, { events, query: "" }))
    const t = translator(lang)
    for (const key of ["cascade.tier1", "cascade.tier2", "cascade.escalated"]) assert.ok(html.includes(t(key)))
    assert.equal((html.match(/data-testid="trace-cascading"/g) ?? []).length, 2)
    assert.ok(html.includes('data-testid="trace-waterfall"'))
  })
  test(`cascade model rack renders mappings, exact micros and missing estimates in ${lang}`, () => {
    const ModelsClient = component("views/models", lang).ModelsClient!
    const html = renderToStaticMarkup(React.createElement(ModelsClient, { models: [], providers: [], catalogModels: [], catalogBindings: [], cascading: [
      { alias: "auto", tier1FastModel: "p:fast", tier2ReasoningModel: "p:deep", estimatedSavingsMicros: 1 },
      { alias: "unknown", tier1FastModel: "p:unpriced", tier2ReasoningModel: "p:deep", estimatedSavingsMicros: null },
    ] }))
    for (const text of ["auto", "p:fast", "p:deep", translator(lang)("cascade.savings", format.formatInt(1)), translator(lang)("cascade.unpriced")]) assert.ok(html.includes(text))
    assert.equal((html.match(/data-testid="cascading-model"/g) ?? []).length, 2)
  })
}
