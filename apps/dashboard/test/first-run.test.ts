/**
 * EVO-G09 A1 — 上游不可达时的首屏顺序。
 *
 * The rule: the first block a visitor sees is the neutral, informational
 * 「先启动上游：mik serve」 guide. A red error banner may only ever be a *reaction* —
 * after the visitor pressed 「我已启动，重试」 and the upstream is still dead.
 *
 * The dashboard has no component-render harness (its tests are plain `node --test`
 * over pure helpers, by design), so the ordering is asserted structurally against
 * the view sources below, and the *rendered-HTML* half of the same claim is asserted
 * by the **DASH** checkpoint in `scripts/e2e/run.mjs`, which fetches `/` against an
 * unreachable `mik serve` and checks what is actually painted.
 *
 *   pnpm --filter @mik/dashboard test
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (relative: string) => readFileSync(join(APP_ROOT, relative), "utf8")

/** The four first-party views, plus the two secondary pages that had the same shape. */
const PAGES = [
  "components/views/overview.tsx",
  "components/views/trends.tsx",
  "components/views/logs.tsx",
  "components/views/pricing.tsx",
  "app/(main)/providers/page.tsx",
  "app/(main)/models/page.tsx",
]

test("every page renders the neutral guide instead of a raw error banner", () => {
  for (const page of PAGES) {
    const source = read(page)
    assert.match(
      source,
      /<UpstreamNotice message=\{(?:upstreamErrors|errors|shell\.errors)\[0\]\}/,
      `${page} no longer renders <UpstreamNotice message={...}>`,
    )
    assert.doesNotMatch(source, /<ErrorBanner/, `${page} still renders <ErrorBanner> directly`)
    assert.doesNotMatch(source, /ErrorBanner[,\s}]/, `${page} still imports ErrorBanner`)
  }
})

test("the overview puts the guide above the filter panel and every data block", () => {
  const source = read("components/views/overview.tsx")
  const header = source.indexOf("<PageHeader")
  const guide = source.indexOf("<UpstreamNotice")
  const filter = source.indexOf("<FilterPanel")
  const firstData = source.indexOf("<CardGrid")

  assert.ok(header >= 0 && guide > header, "the guide must sit below the page header")
  assert.ok(filter > guide, "the guide must be the first block, ahead of the filter panel")
  assert.ok(firstData > guide, "the guide must render ahead of the first data block")
  // And the old "报错 → 解释" ordering must not creep back in.
  assert.ok(!source.includes("<ErrorBanner"), "the overview must not paint an error banner on first paint")
})

test("the error banner is reachable only through the retry guard", () => {
  const source = read("components/upstream-notice.tsx")
  const guard = source.indexOf("{retried && !pending")
  const banner = source.indexOf("<ErrorBanner")

  assert.ok(guard > 0, "the retried guard is gone — the banner would paint on first paint")
  assert.ok(banner > guard, "ErrorBanner must be nested inside the retried guard")
  assert.match(source, /data-testid="upstream-guide"/, "the guide lost its test hook")
  assert.match(source, /MIK_SERVE_COMMAND = "mik serve"/, "the copyable command changed")
  // A healthy upstream renders nothing at all, not an empty placeholder.
  assert.match(source, /if \(!message\) return null/)
})
