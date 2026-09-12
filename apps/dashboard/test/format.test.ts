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
  assert.equal(formatUsd(undefined), "—")
  assert.equal(formatUsd(Number.NaN), "—")
})

test("EVO-G88: formatUsd follows the CLI's usage-money precision rule", () => {
  // The amount EVO-G85 made the CLI print as `0.000654`: the dashboard shows the
  // same micro-USD digits (its own `$` prefix and trailing-zero trim aside).
  assert.equal(formatUsd(0.000654), "$0.000654")
  // 340 µ$ — a per-row amount the CLI prints `0.000340`; the four-decimal
  // rendering of the old code (`$0.0003`) must not come back.
  assert.equal(formatUsd(0.00034), "$0.00034")
  assert.notEqual(formatUsd(0.00034), "$0.0003")
  // Whole-1e-4 amounts keep the four decimals they always had: this is what the
  // pre-change renderer produced for these two inputs, byte for byte.
  assert.equal(formatUsd(0.0081), "$0.0081")
  assert.equal(formatUsd(0.0175), "$0.0175")
  // The clamp is half a micro (R257): 30 µ$ is a real amount, not "<0.0001".
  assert.equal(formatUsd(0.00003), "$0.00003")
  assert.equal(formatUsd(0.000001), "$0.000001")
  // A negative that rounds to zero micro-USD is zero, never "-$0".
  assert.equal(formatUsd(-0.0000001), "$0")
  // An explicit `digits` still wins (chart axes ask for 2, the log panel for 6).
  assert.equal(formatUsd(0.000654, 2), "$0.00")
  assert.equal(formatUsd(0.000654, 6), "$0.000654")
  assert.equal(formatUsd(1.5, 2), "$1.50")
})

test("EVO-G88b: the overview cost-range hint goes through formatUsd, not toFixed(4)", () => {
  // The hint is composed exactly as `components/views/overview.tsx` composes it.
  // Before EVO-G88b that line was a bare `$${v.toFixed(4)}`, which printed a 340 µ$
  // range as `$0.0003` and a 30 µ$ range as `$0.0000` — the same value the CLI and
  // the dashboard's own `formatUsd` render at micro precision (`$0.00034` / `$0.00003`).
  const rangeHint = (low: number, high: number) => `区间 ${formatUsd(low)} ~ ${formatUsd(high)}`

  assert.equal(rangeHint(0.00034, 0.00068), "区间 $0.00034 ~ $0.00068")
  assert.notEqual(rangeHint(0.00034, 0.00068), "区间 $0.0003 ~ $0.0007")
  // 30 µ$ used to be the silent `$0.0000` of the four-decimal rendering.
  assert.equal(rangeHint(0.00003, 0.00006), "区间 $0.00003 ~ $0.00006")
  assert.notEqual(rangeHint(0.00003, 0.00006), "区间 $0.0000 ~ $0.0001")
  // A whole-1e-4 range reads exactly as it did before the change.
  assert.equal(rangeHint(0.0081, 0.0081), "区间 $0.0081 ~ $0.0081")
  // No `toFixed(4)` residue: every bound carries the micro-digits when it has them.
  assert.equal(rangeHint(0.00034, 0.00034), "区间 $0.00034 ~ $0.00034")
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
