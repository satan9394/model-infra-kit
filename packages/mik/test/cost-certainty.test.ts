import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, describe, expect, it } from "vitest"
import { main } from "../src/cli/index.js"
import { Store } from "../src/store/database.js"
import { UsageService, costBound } from "../src/usage/service.js"
import type { CostInfo } from "../src/types.js"

/**
 * EVO-G78 — "cost certainty": never present an unknown amount as an exact one,
 * and never let two commands disagree about their time window in silence
 * (audit-R232 F1/F2/F9/F12).
 *
 * Every assertion here names a **concrete number, token or marker** written as a
 * literal, and each one was run against the published `model-infra-kit@0.2.23`
 * artifact before it was run against this build — the "red before green" probe
 * is in `.tmp/impl-G78.md`, and the raw outputs of both runs are in
 * `.tmp/g78-probe/out/{old,new}.json`. Nothing is derived from the code under
 * test: `costBound()` has its own hand-written expectations, and the CLI strings
 * carry their own digits.
 *
 * The two cost lines are deliberately checked **together** in the mixed case
 * (`at least X` on both) and in the all-priced case (`X – Y` on the range, a
 * plain number on the total), because the failure mode this card fixes is
 * "unknown" being printed as "exact", not "make everything fuzzy".
 */

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g78-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

interface Captured {
  code: number
  stdout: string
  stderr: string
}

async function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, {
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    cwd,
    env: { ...process.env, MIK_LANG: "en", ...env },
    interactive: false,
  })
  return { code, stdout: out.join("\n"), stderr: err.join("\n") }
}

function sandbox(): { dir: string; db: string; base: string[] } {
  const dir = tempDir()
  const db = join(dir, "usage.db")
  return {
    dir,
    db,
    base: [
      "--offline",
      "--db",
      db,
      "--cache-dir",
      join(dir, "cache"),
      "--config",
      join(dir, "mik.config.json"),
      // The seed writes as `cli-app`; the CLI otherwise defaults to `default`.
      "--app-id",
      "cli-app",
    ],
  }
}

interface SeedSpec {
  id: string
  model: string
  source: CostInfo["source"]
  /** `unknown` is what the pricing service records when nothing could be resolved. */
  basis?: CostInfo["basis"]
  input?: number
  cacheRead?: number
  usd?: number
  low?: number
  high?: number
  ts?: number
}

async function seed(dbPath: string, specs: readonly SeedSpec[], appId = "cli-app"): Promise<void> {
  const store = await Store.open({ path: dbPath })
  const usage = new UsageService({ store, appId, enabled: true })
  specs.forEach((spec, index) => {
    const usd = spec.usd ?? 0
    usage.record({
      requestId: spec.id,
      ts: spec.ts ?? Date.parse("2026-09-01T10:00:00.000Z") + index * 1000,
      source: "generate",
      providerId: "deepseek",
      modelRequested: `deepseek:${spec.model}`,
      modelActual: spec.model,
      usage: { input: spec.input ?? 0, output: 0, cacheRead: spec.cacheRead ?? 0, cacheWrite: 0, reasoning: 0 },
      cost: {
        usd,
        low: spec.low ?? usd,
        high: spec.high ?? usd,
        basis: spec.basis ?? "flat",
        source: spec.source,
      },
      latencyMs: 100,
      status: "ok",
      isStreaming: false,
    })
  })
  store.close()
}

/** Two priced requests + one with no resolvable price (`pricing_source=missing`). */
const MIXED: readonly SeedSpec[] = [
  { id: "g78-1", model: "deepseek-chat", source: "modelsdev", input: 1000, usd: 0.01 },
  { id: "g78-2", model: "gpt-4o", source: "modelsdev", input: 1000, usd: 0.01 },
  { id: "g78-3", model: "ghost-model-x", source: "missing", basis: "unknown", input: 500 },
]

describe("EVO-G78 / G79 / G80 — cost certainty and the two time windows", () => {
  it("A1 — one unpriced request turns both cost lines into a named floor", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, MIXED)
    const result = await run(["usage", "summary", ...base], dir)
    expect(result.code).toBe(0)

    // Hand-computed: low = 0.0100 + 0.0100 + 0 (unpriced) = 0.0200.
    expect(result.stdout).toContain("Cost (USD)      at least 0.0200")
    expect(result.stdout).toContain("Cost range      at least 0.0200 (upper bound unknown: 1 request(s) unpriced)")
    // The audited defect, verbatim: the closed interval that read as "exact".
    expect(result.stdout).not.toContain("0.0200 – 0.0200")
    expect(result.stdout).not.toContain("Cost (USD)      0.0200")
  })

  it("A1 (reverse) — with everything priced the interval stays an exact point", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, [
      { id: "p-1", model: "deepseek-chat", source: "modelsdev", input: 1000, usd: 0.01 },
      { id: "p-2", model: "gpt-4o", source: "provider", input: 2000, usd: 0.02 },
      { id: "p-3", model: "claude-sonnet", source: "override", input: 500, usd: 0.03 },
    ])
    const result = await run(["usage", "summary", ...base], dir)
    expect(result.code).toBe(0)
    // Hand-computed: 0.0100 + 0.0200 + 0.0300 = 0.0600, and low == high here.
    expect(result.stdout).toContain("Cost (USD)      0.0600")
    expect(result.stdout).toContain("Cost range      0.0600 – 0.0600")
    expect(result.stdout).not.toContain("at least")
    expect(result.stdout).not.toContain("upper bound unknown")
  })

  it("A1 — the floor is the low estimate, never the recorded point estimate", async () => {
    // `wide-model` estimates a spread: low 0.0100 < usd 0.012345 < high 0.0200.
    // A point estimate is not a proven lower bound, so "at least 0.0123" would
    // overstate the floor by 0.0023 in exactly the case where the price is
    // least certain.
    const { dir, db, base } = sandbox()
    await seed(db, [
      { id: "w-1", model: "wide-model", source: "modelsdev", input: 1000, usd: 0.012345, low: 0.01, high: 0.02 },
      { id: "w-2", model: "ghost-model-x", source: "missing", basis: "unknown", input: 500 },
    ])
    const result = await run(["usage", "summary", ...base], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Cost (USD)      at least 0.0100")
    expect(result.stdout).not.toContain("at least 0.0123")
  })

  it("A1 — costBound() is false only when nothing is missing, and names both blind cases", () => {
    // Expectations are external literals, not the function's own output.
    expect(costBound({ requests: 3 }, { requests: 0, totalRequests: 3 })).toEqual({
      costLowerBoundOnly: false,
      unpricedRequests: 0,
      unmeasuredRequests: 0,
    })
    // Case 1: an unpriced detail row.
    expect(costBound({ requests: 3 }, { requests: 1, totalRequests: 3 })).toEqual({
      costLowerBoundOnly: true,
      unpricedRequests: 1,
      unmeasuredRequests: 0,
    })
    // Case 2: a day folded into `usage_daily_rollups` — its price source is gone,
    // so nobody can say whether it was priced. Unmeasurable is not "priced".
    expect(costBound({ requests: 3 }, { requests: 0, totalRequests: 2 })).toEqual({
      costLowerBoundOnly: true,
      unpricedRequests: 0,
      unmeasuredRequests: 1,
    })
    // A range that shrank under a concurrent delete cannot produce a negative claim.
    expect(costBound({ requests: 2 }, { requests: 0, totalRequests: 3 }).unmeasuredRequests).toBe(0)
  })

  it("A2 — both commands name their window, and name how they differ", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, MIXED)

    const summary = await run(["usage", "summary", ...base], dir)
    expect(summary.code).toBe(0)
    // `- → -` is gone: the implied bound is spelled out.
    expect(summary.stdout).toContain("Range all time (no --from/--to given) · app=cli-app")
    expect(summary.stdout).not.toContain("Range - → -")
    expect(summary.stdout).toContain(
      "Note: with no --from/--to this command covers the whole history; usage trends covers only the last 30 days by default.",
    )

    const trends = await run(["usage", "trends", ...base], dir)
    expect(trends.code).toBe(0)
    // The actual window is printed, and the default that produced it is named.
    expect(trends.stdout).toMatch(/^Range \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} · app=cli-app$/m)
    expect(trends.stdout).toContain(
      "Note: with no --from/--to/--days this command covers only the last 30 days; usage summary and usage logs cover the whole history by default.",
    )
    // Same database in the same session: the two windows really are different,
    // and each command now says so.
    expect(trends.stdout).not.toContain("Range all time")
  })

  it("A2 — with the same explicit bounds there is no window to explain", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, MIXED)
    const window = ["--from", "2026-08-01", "--to", "2026-09-30"]

    const summary = await run(["usage", "summary", ...base, ...window], dir)
    const trends = await run(["usage", "trends", ...base, ...window], dir)
    expect(summary.code).toBe(0)
    expect(trends.code).toBe(0)
    // Identical header on both sides, and neither invents a difference.
    expect(summary.stdout).toContain("Range 2026-08-01 → 2026-09-30 · app=cli-app")
    expect(trends.stdout).toContain("Range 2026-08-01 → 2026-09-30 · app=cli-app")
    expect(summary.stdout).not.toContain("Note: with no --from")
    expect(trends.stdout).not.toContain("Note: with no --from")
  })

  it("A3 — the unpriced ratio counts the same token buckets on both sides", async () => {
    // Priced row: 1,000 input tokens. Unpriced row: 800 input + 200 cacheRead.
    // Hand-computed: numerator 800 + 200 = 1,000; denominator 1,000 + 800 + 200
    // = 2,000 → 50.0%. A numerator that dropped cacheRead would print
    // 800 / 2,000 = 40.0%, which is exactly the audit-R232 F9 mismatch.
    const { dir, db, base } = sandbox()
    await seed(db, [
      { id: "t-1", model: "priced-a", source: "modelsdev", input: 1000, usd: 0.01 },
      { id: "t-2", model: "ghost-model-x", source: "missing", basis: "unknown", input: 800, cacheRead: 200 },
    ])
    const result = await run(["usage", "summary", ...base], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Unpriced tokens    1,000 / 2,000 (50.0%)")
    expect(result.stdout).toContain("Unpriced requests  1 / 2 (50.0%)")
  })

  it("A2 — a one-sided window names the side that was implied", async () => {
    // The other two branches of the span composition: `--from` only and `--to`
    // only. R208: without these, half of `rangeLabel` would never be executed by
    // any test in this file, and a wrong implied-bound word would ship unseen.
    const { dir, db, base } = sandbox()
    await seed(db, MIXED)

    const since = await run(["usage", "logs", ...base, "--from", "2026-08-01"], dir)
    expect(since.code).toBe(0)
    expect(since.stdout).toContain("Range 2026-08-01 to now · app=cli-app")

    const until = await run(["usage", "logs", ...base, "--to", "2026-09-30"], dir)
    expect(until.code).toBe(0)
    expect(until.stdout).toContain("Range everything up to 2026-09-30 · app=cli-app")
  })

  it("A1 — both blind cases at once are both named, semicolon-separated", async () => {
    // The one shape no other test produces: an unpriced *detail* row (counted)
    // and a folded day whose provenance is gone (unmeasured). R208 — the
    // `parts.join("; ")` branch with two elements was covered by nothing.
    const { dir, db, base } = sandbox()
    // `rollupAndPrune` folds every day before *today*, so the retained rows must
    // be timed today and the folded one earlier.
    await seed(db, [
      { id: "f-1", model: "old-ghost", source: "missing", basis: "unknown", input: 900, ts: Date.now() - 3 * 86_400_000 },
      { id: "f-2", model: "today-ghost", source: "missing", basis: "unknown", input: 100, ts: Date.now() },
      { id: "f-3", model: "today-priced", source: "modelsdev", input: 500, usd: 0.02, ts: Date.now() },
    ])
    const store = await Store.open({ path: db })
    new UsageService({ store, appId: "cli-app", enabled: true }).rollupAndPrune(Date.now())
    store.close()

    const result = await run(["usage", "summary", ...base], dir)
    expect(result.code).toBe(0)
    // Hand-computed: 3 requests, 1 folded, 2 detail rows of which 1 is unpriced.
    expect(result.stdout).toContain("Requests        3")
    expect(result.stdout).toContain(
      "Cost range      at least 0.0200 (upper bound unknown: 1 request(s) unpriced; 1 request(s) folded into daily rollups, price source gone)",
    )
  })

  it("A1 — a legacy row with no recorded basis is `unknown`, not `flat`", async () => {
    /**
     * The write-path fix only covers rows written from now on. A pre-G78
     * database still holds `pricing_basis IS NULL` for rows that were never
     * priced, and the read-back fallback turned that into `flat` — the token
     * that means "a real rate was applied". So `usage export` kept printing
     * `missing,flat`: the very defect this card kills was surviving on existing
     * data.
     *
     * The rows are stored the honest way first (through `UsageService`), then
     * the basis column is nulled to reproduce a legacy row — the CLI reads them
     * back through `rowToEvent`.
     */
    const { dir, db, base } = sandbox()
    await seed(db, [
      { id: "l-1", model: "legacy-ghost", source: "missing", basis: "unknown", input: 500 },
      // The safety case: a *priced* legacy row with no recorded basis must keep
      // reading as `flat`, or the fix trades one lie for another.
      { id: "l-2", model: "legacy-priced", source: "modelsdev", basis: "flat", input: 1000, usd: 0.01 },
    ])
    const raw = new DatabaseSync(db)
    raw.exec("UPDATE usage_events SET pricing_basis = NULL")
    raw.close()

    const exported = await run(["usage", "export", ...base], dir)
    expect(exported.code).toBe(0)
    expect(exported.stdout).toContain(",0.0000,missing,unknown,100,")
    // Not harmed: NULL basis with a real price source still reads `flat`.
    expect(exported.stdout).toContain(",0.0100,modelsdev,flat,100,")

    // And the legacy unpriced row is a floor, not a point (the marking reads
    // `pricing_source`, which the nulling left untouched).
    const summary = await run(["usage", "summary", ...base], dir)
    expect(summary.code).toBe(0)
    expect(summary.stdout).toContain("Cost (USD)      at least 0.0100")
    expect(summary.stdout).toContain("Cost range      at least 0.0100 (upper bound unknown: 1 request(s) unpriced)")
  })

  it("A3 — the CSV records `unknown`, and the log legend appears only when it must", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, MIXED)

    const exported = await run(["usage", "export", ...base], dir)
    expect(exported.code).toBe(0)
    // The unpriced row: `pricing_source=missing` **and** `pricing_basis=unknown`.
    // It used to say `flat`, i.e. the token that means "a real rate was applied"
    // — which is what made "free" and "unpriced" indistinguishable in the numbers.
    expect(exported.stdout).toContain(",0.0000,missing,unknown,100,")
    expect(exported.stdout).toContain(",0.0100,modelsdev,flat,100,")
    expect(exported.stdout.split("\n")[0]).toBe(
      "ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms,tags",
    )

    const logs = await run(["usage", "logs", ...base], dir)
    expect(logs.code).toBe(0)
    expect(logs.stdout).toContain("missing     100 ms")
    expect(logs.stdout).toContain(
      "Note: the price source is the raw enum from the record (not localized) — missing means the request was unpriced and recorded at 0 (which is not free)",
    )

    // A fully priced database prints the same table without the legend.
    const clean = sandbox()
    await seed(clean.db, [
      { id: "c-1", model: "deepseek-chat", source: "modelsdev", input: 1000, usd: 0.01 },
      { id: "c-2", model: "gpt-4o", source: "provider", input: 2000, usd: 0.02 },
    ])
    const cleanLogs = await run(["usage", "logs", ...clean.base], clean.dir)
    expect(cleanLogs.code).toBe(0)
    expect(cleanLogs.stdout).toContain("modelsdev")
    expect(cleanLogs.stdout).not.toContain("Note: the price source is the raw enum")
  })
})
