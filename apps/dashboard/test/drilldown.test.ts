import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { parseDateInput } from "../lib/range.ts"
import { preserveFiltersQuery, toRouteHref, readFilters, resolveRange, withRange } from "../lib/range.ts"

const context = { range: "custom", from: "2026-09-30", to: "2026-10-02", provider: "local", model: "a/b", status: "ok", limit: "25", offset: "75", search: "request id" }
const query = (value: string) => new URLSearchParams(value)

test("cross-page links retain all context except pagination", () => {
  const href = toRouteHref("/trends", context)
  assert.equal(href.split("?")[0], "/trends")
  const values = query(href.split("?")[1] ?? "")
  for (const [key, value] of Object.entries(context)) if (key !== "offset") assert.equal(values.get(key), value)
  assert.equal(values.has("offset"), false)
})
test("failure drilldown replaces success status without losing dates or scope", () => {
  const values = query(preserveFiltersQuery(context, { status: "error" }))
  assert.equal(values.get("status"), "error")
  assert.equal(values.get("from"), context.from)
  assert.equal(values.get("model"), context.model)
  assert.equal(values.has("offset"), false)
})
test("provider and model overrides preserve the time window", () => {
  for (const patch of [{ provider: "next" }, { model: "next/model" }]) {
    const values = query(preserveFiltersQuery(context, patch))
    assert.equal(values.get("range"), "custom")
    assert.equal(values.get("to"), context.to)
    for (const [key, value] of Object.entries(patch)) assert.equal(values.get(key), value)
  }
})
test("day drilldown resolves to precisely one local day across month boundaries", () => {
  const values = query(preserveFiltersQuery(context, { range: "custom", from: "2026-09-30", to: "2026-09-30" }))
  const range = resolveRange(Object.fromEntries(values), new Date(2026, 9, 3).getTime())
  assert.equal(range.from, new Date(2026, 8, 30).getTime())
  assert.equal(range.to, new Date(2026, 9, 1).getTime() - 1)
  assert.equal(values.get("provider"), "local")
})
test("empty and undefined overrides delete values and cannot restore offset", () => {
  const values = query(preserveFiltersQuery(context, { provider: "", model: undefined, offset: "100" }))
  assert.equal(values.has("provider"), false)
  assert.equal(values.has("model"), false)
  assert.equal(values.has("offset"), false)
})
test("empty queries and duplicate values are deterministic and do not mutate input", () => {
  assert.equal(preserveFiltersQuery({}), "")
  assert.equal(toRouteHref("/logs", {}), "/logs")
  const input = { provider: ["first", "second"], model: [], empty: "", offset: "10" }
  assert.equal(preserveFiltersQuery(input), "?provider=first")
  assert.deepEqual(input.provider, ["first", "second"])
  assert.equal(input.offset, "10")
})
test("malicious filter text stays a single encoded value", () => {
  const model = 'a&status=error#<script>"?offset=999'
  const href = toRouteHref("/logs", { model })
  const url = new URL(href, "https://dashboard.example")
  assert.equal(url.searchParams.get("model"), model)
  assert.equal(url.searchParams.has("status"), false)
  assert.equal(url.hash, "")
})
test("unsafe navigation targets are rejected", () => {
  for (const route of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", "/logs\n"]) {
    assert.throws(() => toRouteHref(route, context), TypeError)
  }
  assert.equal(toRouteHref("logs", {}), "logs")
  assert.equal(toRouteHref("https://dashboard.example/logs", {}), "https://dashboard.example/logs")
})
test("range changes preserve extra filters and clear stale custom dates", () => {
  const values = query(withRange(context, { range: "7d" }))
  assert.equal(values.get("search"), "request id")
  assert.equal(values.get("status"), "ok")
  assert.equal(values.has("from"), false)
  assert.equal(values.has("to"), false)
  assert.equal(values.has("offset"), false)
})
test("external duplicate and invalid filters use the API readback semantics", () => {
  assert.deepEqual(readFilters({ provider: [" local ", "other"], model: [" a/b "], status: ["error"], limit: "25" }), { provider: "local", model: "a/b", status: "error", limit: 25 })
  assert.equal(readFilters({ status: "<script>", offset: "-1", limit: "Infinity" }).status, undefined)
})
test("impossible calendar dates do not silently roll into a different day", () => {
  for (const day of ["2026-02-30", "2026-13-01", "2026-00-01", "2026-10-00"]) assert.equal(parseDateInput(day), null)
  assert.equal(parseDateInput("2024-02-29"), new Date(2024, 1, 29).getTime())
})
test("existing log pagination epoch boundaries round-trip without widening the day", () => {
  const from = new Date(2026, 9, 7).getTime()
  const to = new Date(2026, 9, 8).getTime() - 1
  const range = resolveRange({ from: String(from), to: String(to), offset: "25" }, new Date(2026, 9, 13).getTime())
  assert.equal(range.from, from)
  assert.equal(range.to, to)
  assert.equal(range.fromInput, "2026-10-07")
  assert.equal(range.toInput, "2026-10-07")
})
test("single-day and preset windows follow calendar midnights through DST", () => {
  const moduleUrl = new URL("../lib/range.ts", import.meta.url).href
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { resolveRange } from ${JSON.stringify(moduleUrl)};
    for (const [month, day, hours] of [[2, 8, 23], [10, 1, 25]]) {
      const date = '2026-' + String(month+1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
      const range = resolveRange({range:'custom',from:date,to:date},new Date(2026,month,day+2).getTime());
      assert.equal(range.to-range.from+1,hours*3600000);
      const week = resolveRange({range:'7d'},new Date(2026,month,day+2,12).getTime());
      assert.equal(week.from,new Date(2026,month,day-4).getTime());
    }
  `], { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
})
