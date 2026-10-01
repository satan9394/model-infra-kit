import assert from "node:assert/strict"
import test from "node:test"
import { BUDGET_TONES, budgetLevel, budgetMoney, type BudgetPeriod } from "../lib/budget.ts"

const period: BudgetPeriod = { spentMicros: 1, limitMicros: 2, remainingMicros: 1, percent: 50, status: "ok", from: 0, to: 1, unpricedRequests: 0, archivedRequests: 0 }
test("budget pill uses the highest daily/monthly level", () => {
  for (const [status, expected] of [["ok", "ok"], ["warning", "warning"], ["exceeded", "exceeded"]] as const) {
    assert.equal(budgetLevel({ advisory: true, currency: "USD", daily: period, monthly: { ...period, status } }), expected)
    assert.match(BUDGET_TONES[status], status === "ok" ? /positive/ : status === "warning" ? /warning/ : /danger/)
  }
  assert.equal(budgetLevel({ advisory: true, currency: "USD", daily: null, monthly: null }), "ok")
})
test("budget display preserves single micros and negative differences", () => {
  assert.equal(budgetMoney(1), "$0.000001")
  assert.equal(budgetMoney(1_234_567), "$1.234567")
  assert.equal(budgetMoney(-1), "−$0.000001")
})
