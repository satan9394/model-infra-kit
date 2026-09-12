import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { main } from "../src/cli/index.js"
import { Store } from "../src/store/database.js"
import { toMicroUsd } from "../src/store/money.js"
import type { UsageEvent } from "../src/types.js"
import { UsageService } from "../src/usage/service.js"

/**
 * EVO-G85 — the **money the human reads** must be the money the export carries.
 *
 * EVO-G81 fixed audit-F4's first layer (`0.0006` — a row sum that no precision
 * can reconcile) by rendering the CSV's `cost_usd` at six decimals and adding
 * the integer `cost_microusd` column. The **second** layer stayed open: the
 * four-decimal *display* surfaces still said `0.0007` for a total the rows add
 * up to as `0.000654`, so the two figures agreed only *after* the reader applied
 * a rounding rule of their own. These tests are the read a user performs:
 * compare the summary's digits with the exported rows' digits, verbatim.
 *
 * Every expectation is an **external literal** — a hand-computed micro total, a
 * hand-typed sentence, the pre-change four-decimal string — and never a value
 * recomputed through the code the assertion is about (R231). The two sentences
 * `usage-unpriced-coverage.test.ts` freezes for EVO-G77/G78/G79 are duplicated
 * here rather than imported, so a dictionary edit cannot move both sides.
 */

/** The audit's F4 fixture, in micro-USD: two of the five calls are unpriced. */
const MIXED_MICROS = [340, 180, 0, 0, 134]
/** Hand-computed: 340 + 180 + 0 + 0 + 134. */
const MIXED_TOTAL_MICROS = 654
/** What the summary printed *before* this card: `(0.000654).toFixed(4)`. */
const PRE_G85_FOUR_DECIMAL_TOTAL = "0.0007"
/** What both surfaces print from this card on: the micro-USD unit, verbatim. */
const G85_EXACT_TOTAL = "0.000654"
/** A priced total with no sub-1e-4 digits: the pre-G85 four-decimal string. */
const WHOLE_MICRO_TOTAL = "0.0030"

interface Captured {
  code: number
  stdout: string
  stderr: string
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mik-g85-"))
}

/** Run the CLI in-process, offline, with `MIK_LANG=en` unless overridden. */
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

function cliBase(dir: string, db: string): string[] {
  return [
    "--offline",
    "--db",
    db,
    "--app",
    "g85-app",
    "--cache-dir",
    join(dir, "cache"),
    "--config",
    join(dir, "mik.config.json"),
  ]
}

/** CRLF → LF, so a `core.autocrlf` checkout compares equal (R99). */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

function seed(store: Store, overrides: Partial<UsageEvent> = {}): void {
  const event: UsageEvent = {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "g85-app",
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "seed",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    pricingModel: overrides.pricingModel,
    usage: overrides.usage ?? { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: overrides.cost ?? { usd: 0.005, low: 0.005, high: 0.005, basis: "flat", source: "modelsdev" },
    latencyMs: overrides.latencyMs ?? 120,
    firstTokenMs: overrides.firstTokenMs,
    status: overrides.status ?? "ok",
    errorCode: overrides.errorCode,
    isStreaming: overrides.isStreaming ?? false,
    sessionId: overrides.sessionId,
    tags: overrides.tags ?? {},
  }
  store.usage.insert(event)
}

/** The `Cost (USD)` value `usage summary` printed, verbatim (prefix included). */
function summaryCostToken(stdout: string): string {
  const match = normalize(stdout).match(/^Cost \(USD\)\s+(?:at least\s+)?(\S+)/m)
  if (!match) throw new Error(`no Cost (USD) line in:\n${stdout}`)
  return match[1]!
}

/** One CSV column's cells, by header name. The fixture's cells carry no comma. */
function csvColumn(stdout: string, column: string): string[] {
  const lines = normalize(stdout).trimEnd().split("\n")
  const header = lines[0]!.split(",")
  const index = header.indexOf(column)
  if (index < 0) throw new Error(`no ${column} column in ${lines[0]}`)
  return lines.slice(1).map((line) => line.split(",")[index] ?? "")
}

/** The audit's shape: priced and unpriced calls under one app, all "today". */
async function seedMixed(dir: string, db: string, micros: readonly number[] = MIXED_MICROS): Promise<void> {
  const base = Date.now()
  const store = await Store.open({ path: db })
  micros.forEach((micro, index) => {
    seed(store, {
      requestId: `g85-${index + 1}`,
      ts: base + index * 1000,
      cost:
        micro > 0
          ? { usd: micro / 1_000_000, low: micro / 1_000_000, high: micro / 1_000_000, basis: "flat", source: "modelsdev" }
          : { usd: 0, low: 0, high: 0, basis: "unknown", source: "missing" },
    })
  })
  store.close()
}

describe("EVO-G85 A1 — the summary and the exported rows read the same digits", () => {
  it("prints the micro-USD total, so the row sum needs no rounding rule", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    await seedMixed(dir, db)

    const summary = await run(["usage", "summary", ...cliBase(dir, db)], dir)
    const exported = await run(["usage", "export", ...cliBase(dir, db)], dir)
    expect(summary.code).toBe(0)
    expect(exported.code).toBe(0)

    const costCells = csvColumn(exported.stdout, "cost_usd")
    const microCells = csvColumn(exported.stdout, "cost_microusd")
    // External expectation: one row per seeded call.
    expect(costCells).toHaveLength(MIXED_MICROS.length)

    const displayed = summaryCostToken(summary.stdout)
    // The figure itself, against a hand-written literal.
    expect(displayed).toBe(G85_EXACT_TOTAL)
    // ...and the pre-change value is pinned as *different*, so this assertion
    // cannot go green on the old renderer (G43).
    expect(displayed).not.toBe(PRE_G85_FOUR_DECIMAL_TOTAL)

    // The read the user performs: add the export's cost column, compare with the
    // number the other command printed. Both sides are the artifacts' own bytes,
    // and no rounding is applied to either side.
    const rowSum = costCells.reduce((total, value) => total + Number(value), 0)
    expect(rowSum.toFixed(6)).toBe(displayed)
    // The same read in the unit money is accumulated in (hard rule 2).
    const rowMicros = microCells.reduce((total, value) => total + Number(value), 0)
    expect(rowMicros).toBe(MIXED_TOTAL_MICROS)
    expect((rowMicros / 1_000_000).toFixed(6)).toBe(displayed)

    // Per-row cells: the exact micro rendering EVO-G81 shipped, unchanged.
    expect(costCells).toEqual(["0.000340", "0.000180", "0.000000", "0.000000", "0.000134"])
    // The unpriced calls stay exactly 0 rather than being guessed at.
    expect(microCells.filter((value) => value === "0")).toHaveLength(2)
    // The floor wording of EVO-G78 still qualifies the figure, at full precision.
    expect(summary.stdout).toContain(`at least ${G85_EXACT_TOTAL}`)

    // The defect, as arithmetic: the four-decimal *rows* sum to 0.0006, which is
    // neither the pre-change total nor the current one. Pinned so a later revert
    // to four decimals cannot pass unnoticed.
    const fourDecimalSum = MIXED_MICROS.map((micro) => (micro / 1_000_000).toFixed(4)).reduce(
      (total, value) => total + Number(value),
      0,
    )
    expect(fourDecimalSum.toFixed(4)).toBe("0.0006")
    expect(fourDecimalSum.toFixed(4)).not.toBe(PRE_G85_FOUR_DECIMAL_TOTAL)
  })

  it("holds on the per-row surfaces too: logs and the trends total", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    await seedMixed(dir, db)

    const logs = await run(["usage", "logs", ...cliBase(dir, db)], dir)
    expect(logs.code).toBe(0)
    // Two priced rows carry 340 µ$ and 134 µ$ — readable against their own CSV.
    expect(logs.stdout).toContain("0.000340")
    expect(logs.stdout).toContain("0.000134")
    // The four-decimal rendering of 340 µ$ must not appear anywhere.
    expect(logs.stdout).not.toContain("0.000300")

    const trends = await run(["usage", "trends", ...cliBase(dir, db)], dir)
    expect(trends.code).toBe(0)
    // One day row plus the `Total` row, both the same micro total (external
    // count: two occurrences).
    expect(normalize(trends.stdout).split(G85_EXACT_TOTAL)).toHaveLength(3)
    expect(trends.stdout).not.toContain(PRE_G85_FOUR_DECIMAL_TOTAL)
  })
})

describe("EVO-G85 A2 — a whole-micro-precision total keeps its old four decimals", () => {
  it("prints `0.0030`, never `0.003000`, when there is nothing below 1e-4", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    // 1000 µ$ + 2000 µ$ = 3000 µ$ = 0.003 exactly: the steady state that must be
    // byte-for-byte what it was before this card.
    const base = Date.now()
    seed(store, {
      requestId: "whole-1",
      ts: base,
      cost: { usd: 0.001, low: 0.001, high: 0.001, basis: "flat", source: "modelsdev" },
    })
    seed(store, {
      requestId: "whole-2",
      ts: base + 1000,
      cost: { usd: 0.002, low: 0.002, high: 0.002, basis: "flat", source: "modelsdev" },
    })
    store.close()

    const summary = await run(["usage", "summary", ...cliBase(dir, db)], dir)
    expect(summary.code).toBe(0)
    // Hand-typed, and identical before and after the card.
    expect(summary.stdout).toContain(`Cost (USD)      ${WHOLE_MICRO_TOTAL}`)
    expect(summary.stdout).toContain(`Cost range      ${WHOLE_MICRO_TOTAL} – ${WHOLE_MICRO_TOTAL}`)
    // The widened form must not leak into a total that has nothing to widen.
    expect(summary.stdout).not.toContain("0.003000")
    // The same two rows exported: the reader's addition still lands on 0.0030.
    const exported = await run(["usage", "export", ...cliBase(dir, db)], dir)
    const rowSum = csvColumn(exported.stdout, "cost_usd").reduce((total, value) => total + Number(value), 0)
    expect(rowSum).toBe(0.003)
    expect(rowSum.toFixed(4)).toBe(WHOLE_MICRO_TOTAL)
    // The CSV side of the contract is untouched by this card: six decimals and
    // the integer column, exactly as EVO-G81 shipped them. Sorted on purpose —
    // the export's row order is not what this card is about.
    expect([...csvColumn(exported.stdout, "cost_usd")].sort()).toEqual(["0.001000", "0.002000"])
    expect([...csvColumn(exported.stdout, "cost_microusd")].sort()).toEqual(["1000", "2000"])
    expect(toMicroUsd(0.001)).toBe(1000)
  })
})

describe("EVO-G85 A3 — EVO-G77/G78/G79 sentences are unchanged", () => {
  it("still prints the folded-library caveat, the unpriced floor and the scope note", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    // One priced call today, one unpriced call old enough to be folded away —
    // the shape that makes all three sentences fire at once.
    seed(store, {
      requestId: "today-priced",
      ts: Date.now(),
      cost: { usd: 0.01, low: 0.01, high: 0.01, basis: "flat", source: "modelsdev" },
    })
    seed(store, {
      requestId: "rolled-unpriced",
      ts: Date.now() - 3 * 86_400_000,
      cost: { usd: 0, low: 0, high: 0, basis: "unknown", source: "missing" },
    })
    store.close()
    const rolling = await Store.open({ path: db })
    new UsageService({ store: rolling, appId: "g85-app", enabled: true }).rollupAndPrune(Date.now())
    rolling.close()

    const summary = await run(["usage", "summary", ...cliBase(dir, db)], dir)
    expect(summary.code).toBe(0)
    expect(summary.stdout).toContain("Requests        2")
    // EVO-G77 — the measurement-scope caveat (hand-typed literal, duplicated
    // from `usage-unpriced-coverage.test.ts` on purpose).
    expect(summary.stdout).toContain(
      "Note: 1 request(s) were folded into daily rollups; those rows record no pricing source, so they are outside the unpriced statistics.",
    )
    // EVO-G78 — the floor wording, at the four decimals this total has (10 000 µ$).
    expect(summary.stdout).toContain("Cost (USD)      at least 0.0100")
    expect(summary.stdout).toContain(
      "Cost range      at least 0.0100 (upper bound unknown: 1 request(s) folded into daily rollups, price source gone)",
    )
    expect(summary.stdout).not.toContain("0.010000")
    // EVO-G79 — the scope notice, on `usage summary`'s own default window.
    expect(summary.stdout).toContain(
      "Note: with no --from/--to this command covers the whole history; usage trends covers only the last 30 days by default.",
    )
    // The unpriced *block* stays silent: the folded day is unmeasurable, not
    // priced (EVO-G77's own decision).
    expect(summary.stdout).not.toContain("Unpriced coverage")
  })
})
