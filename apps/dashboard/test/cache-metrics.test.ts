import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import * as format from "../lib/format.ts"
import { translator } from "../lib/i18n/core.ts"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"

const source = readFileSync(new URL("../components/cache-metrics.tsx", import.meta.url), "utf8")
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const require = createRequire(import.meta.url)
const exports: Record<string, (props: any) => any> = {}
new Function("require", "exports", compiled)((id: string) => id === "../lib/format" ? format : require(id), exports)

test("approximate hit labels retain dictionary and placeholder parity", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of ["cache.approxHit", "cache.approxHitBadge"] as const) {
    assert.ok(en[key].trim() && zh[key].trim())
    assert.doesNotMatch(en[key], /\p{Script=Han}/u)
    assert.match(zh[key], /\p{Script=Han}/u)
    assert.deepEqual(en[key].match(/\{\d+\}/g) ?? [], zh[key].match(/\{\d+\}/g) ?? [])
  }
  assert.match(en["cache.approxHitBadge"], /\{0\}/)
})

test("approximate badge rounds ratios and safely presents unavailable similarity", () => {
  for (const lang of ["en", "zh"] as const) {
    const t = translator(lang)
    for (const [similarity, expected] of [["0.984375", "98%"], ["0.95", "95%"], ["1", "100%"], ["0", "0%"],
      [undefined, "—"], ["", "—"], [" ", "—"], ["invalid", "—"], ["Infinity", "—"], ["-0.1", "—"], ["98", "—"]]) {
      const badge = renderToStaticMarkup(createElement(exports.ApproxCacheHitBadge!, { similarity, label: t("cache.approxHitBadge", "{0}") }))
      assert.match(badge, /data-testid="trace-approx-cache-hit"/)
      assert.match(badge, /bg-positive\/10/)
      assert.ok(badge.includes(t("cache.approxHitBadge", expected)))
      assert.doesNotMatch(badge, /NaN|Infinity|undefined/)
    }
    const status = renderToStaticMarkup(createElement(exports.CacheStatus!, { requestId: "approx", tokens: 0,
      hit: t("cache.hit"), miss: t("cache.miss"), approxHit: true, similarity: "0.984375", approxHitLabel: t("cache.approxHitBadge", "{0}") }))
    assert.match(status, /trace-approx-cache-hit/)
    assert.ok(!status.includes(t("cache.miss")))
  }
})

test("actual surface JSX gates approximate badges strictly and retains local hit anchors", () => {
  const t = translator("en")
  for (const file of ["trace-waterfall.tsx", "logs-client.tsx", "views/traces.tsx"]) {
    const surface = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8")
    // Render the actual badge expressions/CacheStatus invocation, rather than a duplicate fixture implementation.
    const fragments = file === "views/traces.tsx" ? surface.match(/<CacheStatus key=.*?\/>/g) :
      surface.match(/event\.tags\?\._mik_approx_cache_hit === "true" \? <span.*?: null/g)
    assert.equal(fragments?.length, file === "views/traces.tsx" ? 1 : 2, file)
    assert.match(surface, /event\.cacheHit/)
    for (const fragment of fragments!) {
      const jsx = file === "views/traces.tsx" ? fragment : `<>{${fragment}}</>`
      const code = ts.transpileModule(`exports.render = (event, t, ApproxCacheHitBadge, CacheStatus) => (${jsx})`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
      }).outputText
      const harness: Record<string, (...args: any[]) => any> = {}
      new Function("require", "exports", code)(require, harness)
      for (const flag of [undefined, "false", "1", "true"]) {
        const event = { requestId: "surface", cacheHit: true, usage: { cacheRead: 0 },
          tags: flag === undefined ? undefined : { _mik_approx_cache_hit: flag, _mik_approx_similarity: "0.984375" } }
        const html = renderToStaticMarkup(harness.render!(event, t, exports.ApproxCacheHitBadge, exports.CacheStatus))
        assert.equal(html.includes('data-testid="trace-approx-cache-hit"'), flag === "true", `${file}: ${flag}`)
        if (flag === "true") assert.ok(html.includes("[Approx Hit: 98%]"))
        if (file === "views/traces.tsx") assert.match(html, /data-testid="trace-cache-hit"/)
      }
    }
  }
})

test("cache metrics render exact micro-dollar values and translated hit/miss states", () => {
  for (const lang of ["en", "zh"] as const) {
    const t = translator(lang)
    const savings = renderToStaticMarkup(createElement(exports.CacheSavings!, { micros: 1442, label: t("cache.savings") }))
    assert.match(savings, /data-testid="overview-cache-savings"/)
    assert.match(savings, /data-testid="overview-cache-savings-micros"/)
    assert.ok(savings.includes(t("cache.savings")))
    assert.ok(savings.includes("1,442 µUSD"))
    assert.ok(savings.includes("$0.001442"))
    for (const tokens of [0, 800]) {
      const status = renderToStaticMarkup(createElement(exports.CacheStatus!, { requestId: "trace-example", tokens, hit: t("cache.hit"), miss: t("cache.miss") }))
      assert.ok(status.includes(t(tokens ? "cache.hit" : "cache.miss")))
      assert.match(status, /data-testid="trace-cache-status"/)
    }
    const badge = renderToStaticMarkup(createElement(exports.CacheHitBadge!, { label: t("cache.hitBadge") }))
    assert.match(badge, /data-testid="trace-cache-hit"/)
    assert.ok(badge.includes(t("cache.hitBadge")))
    const localHit = renderToStaticMarkup(createElement(exports.CacheStatus!, { requestId: "cached", tokens: 0,
      hit: t("cache.hit"), miss: t("cache.miss"), localHit: true, localHitLabel: t("cache.hitBadge") }))
    assert.ok(localHit.includes(t("cache.hitBadge")))
    assert.ok(!localHit.includes(t("cache.miss")))
  }
  assert.match(renderToStaticMarkup(createElement(exports.CacheSavings!, { label: "Savings" })), /—/)
})

test("overview and traces wire the widgets while retaining the cost anchor", () => {
  const overview = readFileSync(new URL("../components/views/overview.tsx", import.meta.url), "utf8")
  const traces = readFileSync(new URL("../components/views/traces.tsx", import.meta.url), "utf8")
  const logs = readFileSync(new URL("../components/logs-client.tsx", import.meta.url), "utf8")
  const waterfall = readFileSync(new URL("../components/trace-waterfall.tsx", import.meta.url), "utf8")
  assert.match(overview, /overview-cost-span/)
  assert.match(overview, /<CacheSavings micros=\{summaryData\?\.cacheSavingsMicros\}/)
  assert.match(overview, /summaryData\?\.localCacheHitRate/)
  assert.match(overview, /summaryData\.localCacheHits/)
  assert.match(overview, /summaryData\.localCacheRequests/)
  assert.match(overview, /overview-local-cache-hit-rate/)
  assert.match(traces, /tokens=\{event\.usage\.cacheRead\}/)
  assert.match(traces, /event\.cacheHit/)
  assert.match(traces, /localHit=\{event\.cacheHit\}/)
  assert.match(logs, /event\.cacheHit/)
  assert.match(waterfall, /event\.cacheHit/)
})
