/**
 * Unit tests for the presentation helpers the dashboard renders.
 *
 * These are the same functions `scripts/e2e/run.mjs` (check **DASH**) calls to
 * compute the strings it then looks for in the rendered HTML — a formatting
 * change therefore fails here first, with a much smaller blast radius.
 *
 *   pnpm --filter @mik/dashboard test
 *
 * Uses the built-in `node --test` runner (Node ≥ 22 strips the types), so the
 * dashboard needs no test dependency.
 */
import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { mikServerUrl } from "../lib/config.ts"
import { formatCompact, formatInt, formatPercent, formatRate, formatUsd, tokenTotal } from "../lib/format.ts"

test("formatUsd renders the costs the e2e writes", () => {
  // The DASH check asserts exactly these strings against the overview HTML.
  assert.equal(formatUsd(0.0243), "$0.0243")
  assert.equal(formatUsd(0.0018), "$0.0018")
  assert.equal(formatUsd(0), "$0")
  assert.equal(formatUsd(0.00001), "<$0.0001")
  assert.equal(formatUsd(undefined), "—")
  assert.equal(formatUsd(Number.NaN), "—")
})

test("formatInt keeps thousands separators", () => {
  assert.equal(formatInt(9), "9")
  assert.equal(formatInt(1200), "1,200")
  assert.equal(formatInt(undefined), "—")
})

test("formatCompact switches to K/M/B at the documented thresholds", () => {
  assert.equal(formatCompact(999), "999")
  assert.equal(formatCompact(23640), "23.6K")
  assert.equal(formatCompact(2_500_000), "2.50M")
  assert.equal(formatCompact(1_200_000_000), "1.20B")
  assert.equal(formatCompact(null), "—")
})

test("formatRate is the price table's own rendering", () => {
  // P2 of the e2e run: $3/M in, $15/M out — what the pricing page must show.
  assert.equal(formatRate(3), "$3.00")
  assert.equal(formatRate(15), "$15.00")
  assert.equal(formatRate(0.27), "$0.270")
  assert.equal(formatRate(0), "$0")
  assert.equal(formatRate(undefined), "—")
})

test("formatPercent accepts both ratios and percentages", () => {
  assert.equal(formatPercent(0.6667), "66.7%")
  assert.equal(formatPercent(66.67), "66.7%")
  assert.equal(formatPercent(undefined), "—")
})

test("tokenTotal adds all four token classes plus reasoning", () => {
  assert.equal(tokenTotal({ input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 }), 2364)
})

const savedUrl = process.env.MIK_SERVER_URL
afterEach(() => {
  if (savedUrl === undefined) delete process.env.MIK_SERVER_URL
  else process.env.MIK_SERVER_URL = savedUrl
})

test("mikServerUrl defaults to 3211 and normalises a trailing slash", () => {
  delete process.env.MIK_SERVER_URL
  assert.equal(mikServerUrl(), "http://127.0.0.1:3211")

  process.env.MIK_SERVER_URL = "  http://127.0.0.1:4321//  "
  assert.equal(mikServerUrl(), "http://127.0.0.1:4321")

  process.env.MIK_SERVER_URL = "   "
  assert.equal(mikServerUrl(), "http://127.0.0.1:3211")
})
