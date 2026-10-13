import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ts from "typescript"
import { translator } from "../lib/i18n/core.ts"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"
import { BUDGET_TONES, budgetLevel, budgetMoney } from "../lib/budget.ts"
import { connectionAppScope, createConnectionProbe } from "../lib/connection-probe.ts"

const require = createRequire(import.meta.url)
function load(file: string, lang: "en" | "zh", overrides: Record<string, unknown> = {}) {
  const exports: Record<string, ComponentType<any>> = {}
  const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function("exports", "require", compiled)(exports, (id: string) => {
    if (id === "@/lib/i18n/provider") return { useI18n: () => ({ t: translator(lang), lang }) }
    if (id in overrides) return overrides[id]
    return require(id)
  })
  return exports
}
function signal(lang: "en" | "zh", value: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(load("status-indicator", lang).StatusIndicator!, { signal: value }))
}
for (const lang of ["en", "zh"] as const) {
  test(`gateway recovery and SSE loss stay independent (${lang})`, () => {
    const t = translator(lang)
    const offline = signal(lang, { kind: "gateway", status: "offline", rttMs: null })
    assert.ok(offline.includes(t("status.offline")))
    assert.doesNotMatch(offline, /\d+ ms/)
    const ready = signal(lang, { kind: "gateway", status: "ready", rttMs: 37 })
    assert.ok(ready.includes(t("status.ready")))
    assert.match(ready, /37 ms/)
    assert.match(ready, /data-testid="gateway-status-pill"/)
    for (const [connected, error, key] of [[true, null, "status.connected"], [false, "retry", "status.reconnecting"], [false, null, "status.disconnected"]] as const) {
      const stream = signal(lang, { kind: "sse", connected, error, lastEventAt: null })
      assert.ok(stream.includes(t(key)))
      assert.ok(stream.includes(t("status.never")))
      assert.match(stream, /data-testid="sse-status-pill"/)
      assert.doesNotMatch(stream, /37 ms/)
    }
  })
  test(`freshness expires independently of an open stream (${lang})`, () => {
    for (const [at, now, key] of [[null, 0, "status.stale"], [0, 29999, "status.fresh"], [0, 30000, "status.stale"]] as const) {
      assert.ok(signal(lang, { kind: "freshness", refreshedAt: at, now }).includes(translator(lang)(key)))
    }
  })
  test(`provider tests and instance circuits never share a health claim (${lang})`, () => {
    for (const state of ["CLOSED", "OPEN", "HALF_OPEN", null]) {
      const circuit = signal(lang, { kind: "circuit", state })
      assert.ok(circuit.includes(translator(lang)("status.instanceCircuit")))
      assert.ok(circuit.includes(state ?? translator(lang)("status.never")))
      assert.ok(!circuit.includes(translator(lang)("status.activeProbe")))
    }
    assert.ok(signal(lang, { kind: "circuit", state: "CLOSED", unavailable: true }).includes(translator(lang)("status.offline")))
    for (const outcome of [null, "success", "failed"]) {
      const probe = signal(lang, { kind: "probe", outcome, testedAt: null })
      assert.ok(probe.includes(translator(lang)("status.activeProbe")))
      assert.ok(!probe.includes("CLOSED"))
    }
  })
  test(`budget has no percentage without a positive denominator (${lang})`, () => {
    const period = { spentMicros: 0, limitMicros: 100, remainingMicros: 100, percent: 0, status: "ok", unpricedRequests: 0, archivedRequests: 0 }
    for (const daily of [null, { ...period, limitMicros: 0 }, { ...period, limitMicros: -1 }, period]) {
      let index = 0
      const BudgetPill = load("budget-pill", lang, {
        react: { ...require("react"), useState: () => [index++ === 0 ? { daily, monthly: null } : false, () => {}], useEffect: () => {} },
        "@/lib/client-api": {}, "@/lib/budget": { BUDGET_TONES, budgetLevel, budgetMoney },
      }).BudgetPill!
      const html = renderToStaticMarkup(createElement(BudgetPill))
      assert.match(html, /data-testid="budget-pill"/)
      assert.match(html, /data-testid="budget-center"/)
      if (daily === period) assert.match(html, /0%/)
      else { assert.doesNotMatch(html, /\d+%|<progress/); assert.ok(html.includes(translator(lang)("status.budgetUnconfigured"))) }
    }
  })
}
test("new status dictionary keys and placeholders match in both languages", () => {
  assert.deepEqual(Object.keys(en), Object.keys(zh))
  for (const key of Object.keys(en).filter(key => key.startsWith("status.")) as (keyof typeof en)[]) {
    assert.deepEqual(en[key].match(/\{\d+\}/g), zh[key].match(/\{\d+\}/g))
    assert.doesNotMatch(en[key], /\p{Script=Han}/u)
  }
})

test("scope uses authenticated identity; unauthenticated and old diagnostic responses show default", async () => {
  const snapshot = { active: 0, requests: 0, events: 0, connections: [], appId: "host" }
  assert.equal(connectionAppScope({ ...snapshot, authenticated: true, appId: "tenant" }), "tenant")
  assert.equal(connectionAppScope({ ...snapshot, authenticated: false }), "default")
  assert.equal(connectionAppScope(snapshot), "default")
  for (const invalid of [{ ...snapshot, appId: {} }, { ...snapshot, authenticated: "true" }]) {
    const states: string[] = []
    const probe = createConnectionProbe(state => states.push(state.status), async () => Response.json(invalid))
    await probe.run(); probe.dispose()
    assert.equal(states.at(-1), "offline")
  }
})

test("Topbar renders nested-route titles, authenticated scope and one set of controls", () => {
  for (const [path, key] of [["/", "s125"], ["/logs/detail", "s131"], ["/providers", "s87"]]) {
    let stateIndex = 0
    const StatusIndicator = load("status-indicator", "en").StatusIndicator!
    const Topbar = load("topbar", "en", {
      react: { ...require("react"), useState: (initial: unknown) => [[{ status: "ready", snapshot: { appId: "tenant" }, rttMs: 8 }, "tenant", 100, 100][stateIndex++] ?? initial, () => {}], useEffect: () => {}, useRef: (current: unknown) => ({ current }) },
      "next/navigation": { usePathname: () => path },
      "@/lib/connection-probe": {},
      "@/lib/use-events": { useHubEvents: () => ({ connected: false, error: "retry", lastEventAt: null }) },
      "@/components/status-indicator": { StatusIndicator },
      "@/components/budget-pill": { BudgetPill: () => createElement("span", { "data-testid": "budget-pill" }, "budget") },
      "@/components/live-refresh": { LiveRefresh: ({ controlsOnly }: { controlsOnly: boolean }) => { assert.equal(controlsOnly, true); return createElement("button", {}, "refresh") } },
      "@/components/lang-toggle": { LangToggle: () => createElement("div", {}, createElement("select"), createElement("button", {}, "language")) },
    }).Topbar!
    const html = renderToStaticMarkup(createElement(Topbar))
    assert.ok(html.includes(translator("en")(key!)))
    assert.match(html, />tenant</)
    assert.equal((html.match(/<select/g) ?? []).length, 1)
    assert.match(html, /gateway-status-pill/)
    assert.match(html, /sse-status-pill/)
    assert.match(html, /Reconnecting/)
  }
})

test("button-only LiveRefresh does not probe or subscribe", () => {
  const LiveRefresh = load("live-refresh", "en", {
    react: { ...require("react"), useState: (initial: unknown) => [initial, () => {}], useEffect: (effect: () => void) => effect(), useRef: (current: unknown) => ({ current }) },
    "next/navigation": { useRouter: () => ({ refresh: () => {} }) },
    "@/lib/use-events": { useHubEvents: (_handlers: unknown, enabled: boolean) => { assert.equal(enabled, false); return { connected: false, error: null } }, LiveBadge: () => { assert.fail("unexpected badge") } },
    "@/lib/connection-probe": { createConnectionProbe: () => { assert.fail("unexpected probe") } },
    "@/lib/format": {},
  }).LiveRefresh!
  const html = renderToStaticMarkup(createElement(LiveRefresh, { topics: [], controlsOnly: true }))
  assert.equal((html.match(/<button/g) ?? []).length, 1)
  assert.doesNotMatch(html, /connection-probe/)
})

test("SSE recreates terminally closed sources, preserves native retries and cancels on unmount", () => {
  const sources: FakeSource[] = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  let cleanup: (() => void) | undefined
  let state: Record<string, unknown> = {}
  class FakeSource {
    static CLOSED = 2
    readyState = 0
    listeners = new Map<string, Function>()
    constructor(url: string) { assert.equal(url, "/api/events"); sources.push(this) }
    addEventListener(name: string, fn: Function) { this.listeners.set(name, fn) }
    removeEventListener(name: string) { this.listeners.delete(name) }
    close() { this.readyState = 2 }
    emit(name: string) { this.listeners.get(name)?.() }
  }
  const exports: { useHubEvents?: (handlers: object, enabled?: boolean) => unknown } = {}
  const source = readFileSync(new URL("../lib/use-events.tsx", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(compiled, { exports, window: {}, EventSource: FakeSource,
    setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 5000); timers.set(++timerId, fn); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
    require: (id: string) => {
      if (id === "react") return { useRef: (current: unknown) => ({ current }), useState: (initial: Record<string, unknown>) => { state = initial; return [state, (fn: (previous: typeof state) => typeof state) => { state = fn(state) }] }, useEffect: (fn: () => (() => void) | undefined) => { cleanup = fn() } }
      if (id === "./i18n/core.ts") return { message: (key: string) => key }
      if (id === "@/lib/i18n/provider") return {}
      return require(id)
    },
  })
  exports.useHubEvents!({})
  sources[0]!.emit("error")
  assert.equal(timers.size, 0, "native CONNECTING retries stay native")
  sources[0]!.readyState = 2
  sources[0]!.emit("error"); sources[0]!.emit("error")
  assert.equal(timers.size, 1)
  const retry = timers.values().next().value!
  timers.clear(); retry()
  assert.equal(sources.length, 2)
  assert.equal(sources[0]!.listeners.size, 0)
  sources[1]!.readyState = 1; sources[1]!.emit("open")
  assert.equal(state.connected, true)
  assert.equal(state.lastEventAt, null, "opening stream does not invent data freshness")
  sources[1]!.readyState = 2; sources[1]!.emit("error")
  const late = timers.values().next().value!
  cleanup!()
  assert.equal(timers.size, 0)
  late()
  assert.equal(sources.length, 2)
  assert.equal(sources[1]!.listeners.size, 0)
  exports.useHubEvents!({}, false)
  assert.equal(sources.length, 2)
})
