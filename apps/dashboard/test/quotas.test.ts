import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { quotaPercent, quotaRatePercent } from "../lib/quotas.ts"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"

test("quota monetary progress preserves precision beyond Number and clamps exhausted budgets", () => {
  assert.equal(quotaPercent("900719925474099299999999", "1801439850948198599999998"), 50)
  assert.equal(quotaPercent("1", "3"), 33)
  assert.equal(quotaPercent("0", "3"), 0)
  assert.equal(quotaPercent("11", "10"), 100)
  assert.equal(quotaPercent("0", "0"), 100)
  assert.equal(quotaPercent("1"), null)
  assert.equal(quotaPercent("-1", "10"), 0)
})

test("quota rate meters distinguish absent from zero limits and remain bounded", () => {
  assert.equal(quotaRatePercent(0), null)
  assert.equal(quotaRatePercent(0, 0), 100)
  assert.equal(quotaRatePercent(25, 100), 25)
  assert.equal(quotaRatePercent(110, 100), 100)
  assert.equal(quotaRatePercent(-1, 100), 0)
})

test("quota translations cover rates, exact micros, hierarchy and every blocked reason", () => {
  const keys = Object.keys(en).filter((key) => key.startsWith("quotas.")) as (keyof typeof en)[]
  assert.deepEqual(keys.sort(), Object.keys(zh).filter((key) => key.startsWith("quotas.")).sort())
  for (const key of keys) {
    assert.ok(en[key].trim() && zh[key].trim())
    assert.doesNotMatch(en[key], /\p{Script=Han}/u)
  }
  for (const reason of ["RPM_EXCEEDED", "TPM_EXCEEDED", "ORG_BUDGET_EXCEEDED", "APP_BUDGET_EXCEEDED"]) {
    assert.ok(keys.includes(`quotas.${reason}` as keyof typeof en))
  }
})

test("quota surfaces share authenticated proxy polling without replacing cost anchors", () => {
  const panel = readFileSync(new URL("../components/quotas-panel.tsx", import.meta.url), "utf8")
  assert.match(panel, /apiCall<QuotasPayload>\("\/quotas", \{ signal: controller.signal \}\)/)
  assert.match(panel, /if \(pending\) return/)
  assert.match(panel, /if \(!document.hidden\)/)
  assert.match(panel, /controller.abort\(\); clearInterval\(timer\)/)
  assert.match(panel, /setData\(result.ok \? result.data : null\)/)
  assert.match(panel, /data.logs.slice\(0, 50\)/)
  assert.doesNotMatch(panel, /Number\(value\.(daily|monthly)|parseFloat|toFixed/)
  const overview = readFileSync(new URL("../components/views/overview.tsx", import.meta.url), "utf8")
  assert.match(overview, /<QuotasPanel compact \/>/)
  assert.match(overview, /testId="overview-cost-span"/)
  const nav = readFileSync(new URL("../components/nav.tsx", import.meta.url), "utf8")
  assert.match(nav, /href: "\/quotas"/)
})
