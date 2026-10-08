import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"

test("hard budget badges distinguish ready and blocked while preserving budget controls", () => {
  const source = readFileSync(new URL("../components/budget-pill.tsx", import.meta.url), "utf8")
  assert.match(source, /status\?\.hardCap && !error/)
  assert.match(source, /level === "exceeded" \? t\("budget.hardBlocked"\) : t\("budget.hardReady"\)/)
  assert.match(source, /data-testid="budget-hard-cap"/)
  assert.match(source, /overview-budget-pill/)
  assert.match(source, /<progress aria-label=/)
  for (const dictionary of [en, zh]) {
    assert.notEqual(dictionary["budget.hardReady"], dictionary["budget.hardBlocked"])
    assert.ok(dictionary["budget.hardDetail"])
  }
})

test("pricing renders live model rules and localized batch stacking details", () => {
  const source = readFileSync(new URL("../components/pricing-client.tsx", import.meta.url), "utf8")
  const view = readFileSync(new URL("../components/views/pricing.tsx", import.meta.url), "utf8")
  assert.match(view, /pricing\.data\.discounts/)
  assert.match(source, /item\.active \? t\("price.discountActive"/)
  assert.match(source, /rule\.startHourUtc, rule\.endHourUtc, rule\.inputMultiplier, rule\.outputMultiplier/)
  assert.match(source, /data-testid="pricing-batch-rule"/)
  for (const dictionary of [en, zh]) {
    assert.match(dictionary["price.batchRule"], /50%/)
    assert.ok(dictionary["price.discountInactive"])
  }
})
