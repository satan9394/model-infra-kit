/**
 * EVO-G89 — `formatUsdSpan`, the dashboard's money cell for a recorded cost.
 *
 * The overview's headline and the trends section total used to render
 * `UsageSummary.costUsd`, the deprecated point estimate. They now render the
 * recorded band's two endpoints through this helper — the *same* function the
 * pages import, not a copy of its expression (R258): the source-level check in
 * `packages/mik/test/g89-cost-point-estimate.test.ts` then only has to prove
 * that the views pass `costLowUsd`/`costHighUsd` to it.
 *
 *   pnpm --filter @mik/dashboard test
 *
 * Uses the built-in `node --test` runner (Node ≥ 22 strips the types), so the
 * dashboard needs no test dependency.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { formatUsdSpan } from "../lib/format.ts"

test("EVO-G89: a point-priced range renders the single number it always did", () => {
  // `manual` / `flat` / provider-reported costs record `low === high === usd`.
  assert.equal(formatUsdSpan(0.0243, 0.0243), "$0.0243")
  assert.equal(formatUsdSpan(0, 0), "$0")
  // Micro remainders keep the CLI's six-digit rendering (EVO-G85/G88).
  assert.equal(formatUsdSpan(0.00034, 0.00034), "$0.00034")
})

test("EVO-G89: a recorded band renders both endpoints", () => {
  // The shape the repo's own fixtures use (`0.01 / 0.012345 / 0.02`): the point
  // estimate is *not* rendered, and neither endpoint is interpolated.
  assert.equal(formatUsdSpan(0.01, 0.02), "$0.01 ~ $0.02")
  assert.equal(formatUsdSpan(0.00034, 0.000777), "$0.00034 ~ $0.000777")
  // Same separators and digits as the interval hint on the same card.
  assert.equal(formatUsdSpan(0.00875, 0.035), "$0.00875 ~ $0.035")
})

test("EVO-G89: a missing summary stays the dashboard's `—`, not half a range", () => {
  // The loading / upstream-down state passes `undefined` for both endpoints: it
  // must not become `— ~ —`.
  assert.equal(formatUsdSpan(undefined, undefined), "—")
  assert.equal(formatUsdSpan(null, null), "—")
  assert.equal(formatUsdSpan(Number.NaN, Number.NaN), "—")
  // One-sided absence is unreachable through the API type (`costLowUsd` and
  // `costHighUsd` are both `number`); the helper deliberately answers with the
  // floor rather than inventing an upper bound. Declared as an uncovered branch
  // in `.tmp/impl-G89.md` (R208).
  assert.equal(formatUsdSpan(0.01, undefined), "$0.01")
})
