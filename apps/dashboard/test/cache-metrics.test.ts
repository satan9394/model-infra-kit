import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import * as format from "../lib/format.ts"
import { translator } from "../lib/i18n/core.ts"

const source = readFileSync(new URL("../components/cache-metrics.tsx", import.meta.url), "utf8")
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const require = createRequire(import.meta.url)
const exports: Record<string, (props: any) => any> = {}
new Function("require", "exports", compiled)((id: string) => id === "../lib/format" ? format : require(id), exports)

test("cache metrics render exact micro-dollar values and translated hit/miss states", () => {
  for (const lang of ["en", "zh"] as const) {
    const t = translator(lang)
    const savings = renderToStaticMarkup(createElement(exports.CacheSavings!, { micros: 1442, label: t("cache.savings") }))
    assert.match(savings, /data-testid="overview-cache-savings"/)
    assert.ok(savings.includes(t("cache.savings")))
    assert.ok(savings.includes("$0.001442"))
    for (const tokens of [0, 800]) {
      const status = renderToStaticMarkup(createElement(exports.CacheStatus!, { requestId: "trace-example", tokens, hit: t("cache.hit"), miss: t("cache.miss") }))
      assert.ok(status.includes(t(tokens ? "cache.hit" : "cache.miss")))
      assert.match(status, /data-testid="trace-cache-status"/)
    }
  }
  assert.match(renderToStaticMarkup(createElement(exports.CacheSavings!, { label: "Savings" })), /—/)
})

test("overview and traces wire the widgets while retaining the cost anchor", () => {
  const overview = readFileSync(new URL("../components/views/overview.tsx", import.meta.url), "utf8")
  const traces = readFileSync(new URL("../components/views/traces.tsx", import.meta.url), "utf8")
  assert.match(overview, /overview-cost-span/)
  assert.match(overview, /<CacheSavings micros=\{summaryData\?\.cacheSavingsMicros\}/)
  assert.match(traces, /tokens=\{event\.usage\.cacheRead\}/)
})
