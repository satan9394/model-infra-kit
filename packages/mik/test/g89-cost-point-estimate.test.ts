import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { main } from "../src/cli/index.js"
import { Store } from "../src/store/database.js"
import type { UsageEvent } from "../src/types.js"

/**
 * EVO-G89 — `UsageSummary.costUsd` is deprecated, and the product stops reading it.
 *
 * The field is a **point estimate**: a request with no resolved price is recorded
 * at 0 and contributes 0 to `costUsd`, to `costLowUsd` and to `costHighUsd`
 * alike, so once anything is unpriced (or folded into `usage_daily_rollups`) the
 * true total is *above* all three and the point estimate bounds nothing. The card
 * deletes nothing (that would be a major change): it marks the field, and makes
 * the CLI and the dashboard express "total spend" through the interval instead.
 *
 * A1/A3 below are written to be **red before the change** — the CLI assertions
 * fail on the pre-change cell, which printed `summary.costUsd` whenever nothing
 * was unpriced; the source assertions fail on the pre-change tree, which had no
 * `@deprecated` tag and no contract section. The pre-change runs are recorded in
 * `.tmp/impl-G89.md` next to the commands that produced them.
 *
 * Every expected string here is an **external literal** — a hand-typed amount, a
 * hand-typed sentence — never a value recomputed through the code under test
 * (R231). The CLI is exercised through the real `main()`; the dashboard views are
 * read from their real source files, never from a copy of their expression.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..")

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g89-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

interface Captured {
  code: number
  stdout: string
  stderr: string
}

/** In-process CLI run, offline, `MIK_LANG=en` — the frozen English surface. */
async function run(args: readonly string[], cwd: string): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const env: NodeJS.ProcessEnv = { ...process.env, MIK_LANG: "en" }
  delete env.MIK_CACHE_DIR
  const code = await main(args, {
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    cwd,
    env,
    interactive: false,
  })
  return { code, stdout: out.join("\n"), stderr: err.join("\n") }
}

function cliBase(dir: string, db: string): string[] {
  return ["--offline", "--db", db, "--app", "g89-app", "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")]
}

function seed(store: Store, overrides: Partial<UsageEvent> = {}): void {
  const event: UsageEvent = {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "g89-app",
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "seed",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    usage: overrides.usage ?? { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: overrides.cost ?? { usd: 0.00034, low: 0.00034, high: 0.00034, basis: "flat", source: "modelsdev" },
    latencyMs: overrides.latencyMs ?? 120,
    status: overrides.status ?? "ok",
    isStreaming: overrides.isStreaming ?? false,
    tags: overrides.tags ?? {},
  }
  store.usage.insert(event)
}

/** The value cell of a `key  value` line of `usage summary`. */
function cell(stdout: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = stdout.match(new RegExp(`^${escaped}\\s{2,}(.+)$`, "m"))
  expect(match, `no "${label}" line in:\n${stdout}`).not.toBeNull()
  return match![1]!.trim()
}

/** One priced request whose recorded range is a *spread*, not a point. */
const SPREAD = { usd: 0.0005, low: 0.00034, high: 0.000777, basis: "flat", source: "manual" } as const
const SPREAD_USD_TEXT = "0.0005"
const SPREAD_LOW_TEXT = "0.000340"
const SPREAD_HIGH_TEXT = "0.000777"
const SPREAD_RANGE_TEXT = `${SPREAD_LOW_TEXT} – ${SPREAD_HIGH_TEXT}`

/**
 * One fully priced request whose rate is recorded **at a point** (no spread):
 * the three cost fields are one number. The equality comes from the price
 * source recording no band, not from the range being fully priced.
 */
const FLAT = { usd: 0.00034, low: 0.00034, high: 0.00034, basis: "flat", source: "manual" } as const
const FLAT_TEXT = "0.000340"

describe("EVO-G89 A3 — the CLI expresses the total through the interval, not the point", () => {
  it("a priced request with a spread: the single-value cell is the lower endpoint", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "g89-spread", cost: SPREAD })
    store.close()

    const result = await run(["usage", "summary", ...cliBase(dir, db)], dir)
    expect(result.code).toBe(0)

    // Nothing is unpriced and nothing was folded, so this is *not* the G78 floor
    // case: the cell is the recorded band, and the surrounding output carries no
    // "at least" wording.
    expect(cell(result.stdout, "Cost (USD)")).toBe(SPREAD_RANGE_TEXT)
    // The pre-change renderer put the deprecated point estimate here.
    expect(cell(result.stdout, "Cost (USD)")).not.toBe(SPREAD_USD_TEXT)
    // The band is on both cost lines — the same shape the G78 bound case has
    // (there, both lines print the same floor), so the two can never contradict
    // each other. Neither line reads `UsageSummary.costUsd`.
    expect(cell(result.stdout, "Cost range")).toBe(SPREAD_RANGE_TEXT)
    expect(result.stdout).not.toContain("at least")
    expect(result.stdout).not.toContain("upper bound unknown")
  })

  it("a point-priced request (fully priced, no spread): one number in all three fields, output unchanged", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "g89-flat", cost: FLAT })
    const summary = store.usage.summary()
    store.close()

    // The fact the migration note rests on: a rate recorded at a point means
    // `low == usd == high`. The condition is the price source having no spread,
    // not the range being fully priced — `llm-pricing` records a band
    // (`low < usd < high`) for tier estimates even when nothing is missing.
    expect(summary.costLowUsd).toBe(0.00034)
    expect(summary.costUsd).toBe(0.00034)
    expect(summary.costHighUsd).toBe(0.00034)

    const result = await run(["usage", "summary", ...cliBase(dir, db)], dir)
    expect(result.code).toBe(0)
    // Byte-identical to the pre-change cell: `costUsd` and `costLowUsd` are the
    // same number here, which is why this card is not a breaking change.
    expect(cell(result.stdout, "Cost (USD)")).toBe(FLAT_TEXT)
    expect(cell(result.stdout, "Cost range")).toBe(`${FLAT_TEXT} – ${FLAT_TEXT}`)
  })

  it("an unpriced request: G78's floor wording is not regressed", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, {
      requestId: "g89-unpriced",
      cost: { usd: 0, low: 0, high: 0, basis: "unknown", source: "missing" },
    })
    store.close()

    const result = await run(["usage", "summary", ...cliBase(dir, db)], dir)
    expect(result.code).toBe(0)
    expect(cell(result.stdout, "Cost (USD)")).toBe("at least 0.0000")
    expect(cell(result.stdout, "Cost range")).toBe("at least 0.0000 (upper bound unknown: 1 request(s) unpriced)")
    expect(result.stdout).toContain("1 request(s) unpriced")
  })
})

describe("EVO-G89 A2 — `costUsd` is still populated, and existing readers still work", () => {
  it("keeps the recorded point total, beside both endpoints", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "g89-kept", cost: SPREAD })
    const summary = store.usage.summary()
    store.close()

    // External literals: the amounts the fixture asked for, not values read back
    // through the same summary under test.
    expect(summary.costUsd).toBe(0.0005)
    expect(summary.costLowUsd).toBe(0.00034)
    expect(summary.costHighUsd).toBe(0.000777)

    // A host's existing formatting code (the shape EVO-G85 taught callers) must
    // not throw: the field is still a finite number, only deprecated.
    expect(typeof summary.costUsd).toBe("number")
    expect(summary.costUsd.toFixed(6)).toBe("0.000500")
  })
})

describe("EVO-G89 A1 — the deprecation is visible in the public type and the contract", () => {
  it("`UsageSummary.costUsd` carries a @deprecated JSDoc naming the replacements", () => {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "types.ts"), "utf8")
    const summaryStart = source.indexOf("export interface UsageSummary {")
    const summaryEnd = source.indexOf("export interface UnpricedModelCoverage")
    expect(summaryStart, "UsageSummary is gone from src/types.ts").toBeGreaterThan(-1)
    expect(summaryEnd).toBeGreaterThan(summaryStart)
    const block = source.slice(summaryStart, summaryEnd)

    const costUsdAt = block.indexOf("costUsd: number")
    expect(costUsdAt, "no `costUsd: number` in UsageSummary").toBeGreaterThan(-1)
    // The JSDoc **immediately above the field** is the one that must carry the tag:
    // a `@deprecated` somewhere else in the interface would not mark this field.
    const preceding = block.slice(0, costUsdAt)
    const lastDoc = preceding.slice(preceding.lastIndexOf("/**"))
    expect(lastDoc).toContain("@deprecated")
    // Reason and migration path, both named.
    expect(lastDoc).toContain("recorded")
    expect(lastDoc).toContain("costLowUsd")
    expect(lastDoc).toContain("costHighUsd")
    expect(lastDoc).toContain("costLowerBoundOnly")
    // The card deletes nothing: the field is documented as still populated.
    expect(lastDoc).toContain("still populated")
  })

  it("docs/interfaces.md states the deprecation, the replacements and low == usd == high", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "interfaces.md"), "utf8")
    // The section heading, not just any mention: the API block up top points here,
    // so `indexOf("EVO-G89")` would find the pointer and read the wrong region.
    const start = doc.indexOf("## EVO-G89")
    expect(start, "no EVO-G89 section in docs/interfaces.md").toBeGreaterThan(-1)
    const section = doc.slice(start, start + 4000)
    expect(section).toContain("@deprecated")
    expect(section).toContain("costLowUsd")
    expect(section).toContain("costHighUsd")
    expect(section).toContain("costLowerBoundOnly")
    // The one fact the migration is safe on, stated for the reader.
    expect(section).toContain("costLowUsd === costUsd === costHighUsd")
  })
})

describe("EVO-G89 A3 — the dashboard's spend surfaces do not read the point estimate", () => {
  const views = join("apps", "dashboard", "components", "views")

  it("`overview` renders the summary as the recorded band", () => {
    const source = readFileSync(join(REPO_ROOT, views, "overview.tsx"), "utf8")
    // The real call site, in the real file: both endpoints, never the point.
    expect(source).toContain("formatUsdSpan(summaryData?.costLowUsd, summaryData?.costHighUsd)")
    // The deprecated field is not read by this view. These three literals are the
    // only shapes a summary's `costUsd` could appear in here (R258: the claim is
    // scoped to the read shapes, not to the word `costUsd`, which the bucket
    // tables legitimately use).
    expect(source).not.toContain("summaryData?.costUsd")
    expect(source).not.toContain("summaryData.costUsd")
    expect(source).not.toContain("summary.costUsd")
    // The interval is still on the same card, so nothing became unsayable.
    expect(source).toContain("summaryData.costLowUsd")
    expect(source).toContain("summaryData.costHighUsd")
  })

  it("`trends` renders its section total as the recorded band", () => {
    const source = readFileSync(join(REPO_ROOT, views, "trends.tsx"), "utf8")
    expect(source).toContain("formatUsdSpan(totals?.costLowUsd, totals?.costHighUsd)")
    expect(source).not.toContain("totals?.costUsd")
    expect(source).not.toContain("totals.costUsd")
  })
})
