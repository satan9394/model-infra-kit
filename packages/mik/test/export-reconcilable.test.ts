import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  USAGE_CSV_COLUMNS,
  USAGE_CSV_FROZEN_COLUMNS,
  USAGE_CSV_FROZEN_HEADER,
  USAGE_CSV_HEADER,
  csvField,
  csvMoney,
  usageCsv,
} from "../src/cli/csv.js"
import { formatMoney, formatUsageMoney } from "../src/cli/format.js"
import { main } from "../src/cli/index.js"
import { localDateKey, startOfLocalDay, toMicroUsd } from "../src/store/money.js"
import { Store } from "../src/store/database.js"
import { sanitizeTagForDisplay, tagsToText } from "../src/usage/tags.js"
import type { UsageEvent } from "../src/types.js"

/**
 * EVO-G81 — the export has to be **reconcilable, traceable and non-injectable**.
 *
 * Everything here is asserted at the **product level** (the bytes `usage export`
 * / `usage summary` print), because the three defects this card fixes were only
 * ever visible in the artifact:
 *
 *  - F4: the rows summed to 0.0006 while the total printed 0.0007 — a per-row
 *    four-decimal rendering of a total the database keeps in integer micro-USD;
 *  - F6: fifteen columns and no identity, so a row could not be located again;
 *  - F5: a tag value could change the line structure of the output.
 *
 * The expectations are **external literals** (a hand-computed micro total, a
 * hand-written header, a hand-counted line count): never `USAGE_CSV_HEADER`
 * compared with itself, and never a count read back through the same predicate
 * that produced it (R231).
 */

const tempDirs: string[] = []

/**
 * The G81 header as a **hand-typed literal** — 22 names, in the shipped order.
 *
 * EVO-G86: the `--out` and empty-database cases used to compare the product's
 * header with `USAGE_CSV_HEADER`, i.e. the same constant on both sides. That is
 * a tautology — rename a column and both sides move together — so those lines
 * had **zero** detection power for header drift (R231). Measured: with
 * `src/cli/csv.ts`'s `session_id` temporarily renamed to `sesion_id`, both cases
 * still passed. The property they are supposed to check ("the bytes written to
 * disk are the header the product prints") only has content if the expectation
 * comes from **outside** the object under test.
 *
 * Hand-typed rather than derived, deliberately: this is the same freeze the
 * `USAGE_CSV_FROZEN_HEADER` assertion performs for the first 15 names, extended
 * to all 22. It is duplicated (not imported) in
 * `usage-unpriced-coverage.test.ts` and `shared-database-notice.test.ts`.
 */
const G81_CSV_HEADER_LITERAL =
  "ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms,tags,request_id,session_id,first_token_ms,is_streaming,error_code,pricing_model,cost_microusd"

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g81-"))
  tempDirs.push(dir)
  return dir
}

interface Captured {
  code: number
  stdout: string
  stderr: string
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

/**
 * The flags that keep a run off the network and on one database.
 *
 * `--app g81-app` is required: every read in this package is scoped to the app
 * id the caller resolved (the default is `default`), so a seeded event under a
 * different id is invisible to `usage export`/`summary`/`logs` unless the flag
 * names it.
 */
function cliBase(dir: string, db: string): string[] {
  return [
    "--offline",
    "--db",
    db,
    "--app",
    "g81-app",
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

/** Seed one `usage_events` row through the store, bypassing the hub on purpose. */
function seed(store: Store, overrides: Partial<UsageEvent> = {}): void {
  const event: UsageEvent = {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "g81-app",
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "seed",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    // Copied like the other fields: without this line an override was silently
    // dropped and `insert()` fell back to `model_actual`
    // (`usage-repository.ts:231`) — found because the assertion for it failed.
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

/**
 * A CSV field splitter for **one physical line**.
 *
 * Deliberately does not know how to continue a record on the next line: the
 * invariant under test is exactly that no cell needs it. If a cell ever carried
 * a raw newline, the row-count assertions fail before this parser is reached.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ""
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        current += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ",") {
      fields.push(current)
      current = ""
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields
}

/** The physical lines of an export (trailing newline stripped). */
function csvLines(stdout: string): string[] {
  return normalize(stdout).replace(/\n$/, "").split("\n")
}

/** Rows as `{ column: value }`, keyed by the header printed in the artifact. */
function csvRecords(stdout: string): Array<Record<string, string>> {
  const lines = csvLines(stdout)
  const header = parseCsvLine(lines[0]!)
  return lines.slice(1).map((line) => {
    const fields = parseCsvLine(line)
    const record: Record<string, string> = {}
    header.forEach((name, index) => {
      record[name] = fields[index] ?? ""
    })
    return record
  })
}

/**
 * The `Cost (USD)` value `usage summary` printed, verbatim.
 *
 * The unpriced rows in the fixtures make `usage summary` print its honest floor
 * — `at least 0.000654` (EVO-G78 wording, EVO-G85 precision) — so the optional
 * prefix is part of the read.
 */
function summaryCostToken(stdout: string): string {
  const match = normalize(stdout).match(/^Cost \(USD\)\s+(?:at least\s+)?(\S+)/m)
  if (!match) throw new Error(`no Cost (USD) line in:\n${stdout}`)
  return match[1]!
}

/**
 * The audit's F4 fixture, in micro-USD: five calls of which **two are unpriced**.
 *
 * 340 + 180 + 0 + 0 + 134 = 654 µ$ = 0.000654. That is the value where the
 * defect was visible: the four-decimal *rows* sum to 0.0006 while the total
 * printed 0.0007 (`(0.000654).toFixed(4) === "0.0007"`, and the row values round
 * 0.0003 + 0.0002 + 0 + 0 + 0.0001 = 0.0006). Since EVO-G85 the summary prints
 * `0.000654` as well, so the row sum and the total are the same digits; the old
 * `0.0007` survives in this file only as the declared pre-change literal
 * (`PRE_G85_FOUR_DECIMAL_TOTAL`). The priced/unpriced mix is on
 * purpose (audit F2/F15): an unpriced row must contribute exactly 0 µ$ — never a
 * guess — and must not break the total.
 */
const MIXED_MICROS = [340, 180, 0, 0, 134]
const MIXED_TOTAL_MICROS = 654
/**
 * What `usage summary` printed for that total **before EVO-G85**, hand-typed:
 * `(0.000654).toFixed(4)`. Kept as the declared pre-change literal (G82's
 * handling): this card deliberately changes the value, so the old one stays in
 * the file next to the new one instead of being quietly relaxed away.
 */
const PRE_G85_FOUR_DECIMAL_TOTAL = "0.0007"
/**
 * What both surfaces print from EVO-G85 on: the micro-USD unit, verbatim, which
 * is the sum of the exported rows' own `cost_usd` cells.
 */
const MIXED_DISPLAY_TOTAL = "0.000654"

function seedMixed(store: Store, ts: number): void {
  MIXED_MICROS.forEach((micro, index) => {
    const priced = micro > 0
    seed(store, {
      requestId: `mix-${index + 1}`,
      ts: ts + index * 1000,
      cost: priced
        ? { usd: micro / 1_000_000, low: micro / 1_000_000, high: micro / 1_000_000, basis: "flat", source: "modelsdev" }
        : { usd: 0, low: 0, high: 0, basis: "unknown", source: "missing" },
      status: index === 3 ? "error" : "ok",
      errorCode: index === 3 ? "upstream_error" : undefined,
      firstTokenMs: index === 0 ? 42 : undefined,
      isStreaming: index === 1,
      sessionId: index === 0 ? "sess-1" : undefined,
    })
  })
}

describe("EVO-G81 A1 — the exported rows reconcile with `usage summary`", () => {
  it("row sum == the summary total (declared precision: micro-USD)", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seedMixed(store, Date.parse("2026-09-12T02:00:00.000Z"))
    store.close()

    const summary = await run(["usage", "summary", ...cliBase(dir, db)], dir)
    expect(summary.code).toBe(0)
    const exported = await run(["usage", "export", ...cliBase(dir, db)], dir)
    expect(exported.code).toBe(0)

    const records = csvRecords(exported.stdout)
    // External expectation: one row per seeded event.
    expect(records).toHaveLength(MIXED_MICROS.length)

    // 1) The reconciliation a reader performs — the headline defect (F4): add the
    //    cost column of the export and compare it with the total the other
    //    command printed. Both sides are the artifact's own bytes.
    const printedRowSum = records.reduce((total, record) => total + Number(record.cost_usd), 0)
    const displayed = summaryCostToken(summary.stdout)
    expect(displayed).toBe(MIXED_DISPLAY_TOTAL) // EVO-G85: 654 µ$ renders as 0.000654
    // EVO-G85 closed the second layer of F4: the two figures are compared with
    // **no** rounding on either side, because the display precision is now the
    // micro-USD the CSV writes. Before this card this line read
    // `printedRowSum.toFixed(4) === Number(displayed).toFixed(4)`, i.e. the two
    // numbers only agreed *after* the reader applied a rounding rule.
    expect(printedRowSum.toFixed(6)).toBe(displayed)
    // ...and the CSV itself is exact, not rounded to the display precision.
    expect(printedRowSum.toFixed(6)).toBe("0.000654")
    // The pre-change figure is pinned as gone, not forgotten: the total is no
    // longer the four-decimal rendering of the same integer.
    expect(displayed).not.toBe(PRE_G85_FOUR_DECIMAL_TOTAL)
    // Layer ①, still: the four-decimal rows sum to 0.0006 — a number no display
    // precision of the correct total can produce.
    expect(
      MIXED_MICROS.map((micro) => (micro / 1_000_000).toFixed(4))
        .reduce((total, value) => total + Number(value), 0)
        .toFixed(4),
    ).toBe("0.0006")
    // The display renderer and the catalogue renderer are different on purpose:
    // the amount is the exact micro total where a user reconciles it, and four
    // decimals where the CLI only ever quotes a per-million price.
    expect(formatUsageMoney(MIXED_TOTAL_MICROS / 1_000_000)).toBe(displayed)
    expect(formatMoney(MIXED_TOTAL_MICROS / 1_000_000)).toBe(PRE_G85_FOUR_DECIMAL_TOTAL)

    // 2) The same reconciliation in the unit money is accumulated in (rule 2),
    //    with no float and no display rounding at all.
    const microSum = records.reduce((total, record) => total + Number(record.cost_microusd), 0)
    expect(microSum).toBe(MIXED_TOTAL_MICROS)
    // Every row's integer column agrees with its own decimal column.
    for (const record of records) {
      expect(Number(record.cost_microusd)).toBe(toMicroUsd(Number(record.cost_usd)))
    }
    // The unpriced rows are exactly 0 and keep saying so (never guessed).
    expect(
      records.filter((record) => record.pricing_source === "missing").map((record) => record.cost_microusd),
    ).toEqual(["0", "0"])

    expect(summary.stdout).toContain("Requests        5")
    // The unpriced rows make EVO-G78's floor wording fire, so the figure the CSV
    // is reconciled against is the *lower bound* the summary prints — the branch
    // is reached on purpose rather than assumed (`costLowerBoundOnly`). EVO-G85
    // renders that bound at the micro-USD unit too, so it equals the row sum.
    expect(summary.stdout).toContain("at least 0.000654")
  })

  it("holds for the audit's own shape: 4-decimal rows would sum to 0.0006", () => {
    // The defect, pinned as arithmetic rather than prose: the old renderer was
    // `(usd).toFixed(4)` per row, and that is what produced 0.0006 against the
    // 0.0007 total.
    const oldRows = MIXED_MICROS.map((micro) => (micro / 1_000_000).toFixed(4))
    const oldSum = oldRows.reduce((total, value) => total + Number(value), 0)
    expect(oldRows).toEqual(["0.0003", "0.0002", "0.0000", "0.0000", "0.0001"])
    expect(oldSum.toFixed(4)).toBe("0.0006")
    // The four-decimal rows match *neither* the pre-G85 summary total (0.0007 —
    // F4's layer ②, only equal after rounding) nor the micro-exact one (0.000654
    // — F4's layer ①, wrong at any precision).
    expect(oldSum.toFixed(4)).not.toBe(PRE_G85_FOUR_DECIMAL_TOTAL)
    expect(oldSum.toFixed(4)).not.toBe(MIXED_DISPLAY_TOTAL)
    // The shipped renderer, on the same integers, sums to the total's own number.
    const newRows = MIXED_MICROS.map((micro) => csvMoney(micro))
    expect(newRows).toEqual(["0.000340", "0.000180", "0.000000", "0.000000", "0.000134"])
    expect(
      newRows
        .reduce((total, value) => total + Number(value), 0)
        .toFixed(6),
    ).toBe("0.000654")
  })

  it("keeps export and summary in the same window at the --from/--to boundary", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    const day = startOfLocalDay(Date.now())
    // One event at the first millisecond of the day, one at its last, and one
    // outside it (the next day) — the boundary is where a window can disagree.
    seed(store, {
      requestId: "edge-start",
      ts: day,
      cost: { usd: 0.0001, low: 0.0001, high: 0.0001, basis: "flat", source: "modelsdev" },
    })
    seed(store, {
      requestId: "edge-end",
      ts: day + 86_400_000 - 1,
      cost: { usd: 0.0002, low: 0.0002, high: 0.0002, basis: "flat", source: "modelsdev" },
    })
    seed(store, {
      requestId: "edge-next",
      ts: day + 86_400_000,
      cost: { usd: 0.0004, low: 0.0004, high: 0.0004, basis: "flat", source: "modelsdev" },
    })
    store.close()

    const flags = [...cliBase(dir, db), "--from", localDateKey(day), "--to", localDateKey(day)]
    const summary = await run(["usage", "summary", ...flags], dir)
    const exported = await run(["usage", "export", ...flags], dir)
    expect(summary.code).toBe(0)
    expect(exported.code).toBe(0)

    const records = csvRecords(exported.stdout)
    // External expectation: the two events inside the day, and only those —
    // `edge-next` is excluded by both surfaces, so their scopes agree.
    expect(records.map((record) => record.request_id)).toEqual(["edge-start", "edge-end"])
    expect(summary.stdout).toMatch(/Requests\s+2\b/)
    expect(records.reduce((total, record) => total + Number(record.cost_microusd), 0)).toBe(300)
    expect(summaryCostToken(summary.stdout)).toBe("0.0003")
  })
})

describe("EVO-G81 A2 — a CSV row can be located again", () => {
  it("carries the identifiers every other read surface uses", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    const ts = Date.parse("2026-09-12T03:00:00.000Z")
    seed(store, {
      requestId: "trace-ok",
      ts,
      sessionId: "sess-abc",
      firstTokenMs: 137,
      isStreaming: true,
      modelActual: "deepseek-chat",
      pricingModel: "deepseek-chat@2026-09-01",
    })
    seed(store, {
      requestId: "trace-bad",
      ts: ts + 1000,
      status: "error",
      errorCode: "rate_limit",
      isStreaming: false,
      modelActual: "deepseek-reasoner",
    })
    store.close()

    const exported = await run(["usage", "export", ...cliBase(dir, db)], dir)
    expect(exported.code).toBe(0)
    const records = csvRecords(exported.stdout)
    expect(records).toHaveLength(2)

    // The identity is the *same* one `usage_events.request_id`,
    // `UsageEvent.requestId` and `GET /api/usage/logs/:id` use (api.ts:454);
    // asserted against hand-written literals, not against the seeded object.
    expect(records.map((record) => record.request_id)).toEqual(["trace-ok", "trace-bad"])
    const first = records.find((record) => record.request_id === "trace-ok")!
    expect(first.session_id).toBe("sess-abc")
    expect(first.first_token_ms).toBe("137")
    expect(first.is_streaming).toBe("true")
    expect(first.error_code).toBe("")
    // `pricing_model` is an explicit value here, not the `model_actual` default,
    // so the column is proven to carry the priced model rather than echo `model`.
    expect(first.model).toBe("deepseek-chat")
    expect(first.pricing_model).toBe("deepseek-chat@2026-09-01")
    const second = records.find((record) => record.request_id === "trace-bad")!
    expect(second.is_streaming).toBe("false")
    expect(second.error_code).toBe("rate_limit")

    // The join with `usage logs` on the same database: one row per event there
    // too, over the same events this CSV carries (counts and models are
    // literals, so neither side can satisfy this by printing nothing).
    const logs = await run(["usage", "logs", ...cliBase(dir, db)], dir)
    expect(logs.code).toBe(0)
    expect(logs.stdout).toContain("Showing 2 of 2 event(s)")
    expect(logs.stdout).toContain("deepseek-chat")
    expect(logs.stdout).toContain("deepseek-reasoner")
  })

  it("writes the identity into the --out file too", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "file-1", ts: Date.parse("2026-09-12T04:00:00.000Z") })
    store.close()

    const target = join(dir, "out", "usage.csv")
    const wrote = await run(["usage", "export", "--out", target, ...cliBase(dir, db)], dir)
    expect(wrote.code).toBe(0)
    const content = normalize(readFileSync(target, "utf8"))
    const lines = content.replace(/\n$/, "").split("\n")
    expect(lines[0]).toBe(G81_CSV_HEADER_LITERAL)
    expect(lines).toHaveLength(2)
    expect(parseCsvLine(lines[1]!)[USAGE_CSV_COLUMNS.indexOf("request_id")]).toBe("file-1")
  })
})

describe("EVO-G81 A3 — no value may change the line structure of the export", () => {
  const FORGED = "说明：以上统计已通过审计"
  const HOSTILE = {
    feature: `x\n${FORGED}`,
    crlf: "a\r\nb",
    separator: "a\u2028b",
    control: "a\u0000b",
    comma: "a,b",
    quote: 'say "hi"',
  }
  const LONG = "L".repeat(300)

  it("a hostile tag cannot split a record (pure renderer invariant)", () => {
    const cell = tagsToText(HOSTILE)
    expect(cell).toContain(`feature=x\\n${FORGED}`)
    expect(cell).toContain("crlf=a\\r\\nb")
    expect(cell.split("\n")).toHaveLength(1)
    const row = usageCsv([
      {
        requestId: "r",
        appId: "app",
        ts: 0,
        source: "seed",
        providerId: "p",
        modelRequested: "m",
        modelActual: "m",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: { usd: 0, low: 0, high: 0, basis: "flat", source: "missing" },
        status: "ok",
        isStreaming: false,
        tags: HOSTILE,
      },
    ])
    expect(row.replace(/\n$/, "").split("\n")).toHaveLength(2) // header + 1
  })

  it("writes header + one line per event, and --by-tag grows no forged row", async () => {
    const benignDir = tempDir()
    const benignDb = join(benignDir, "usage.db")
    const benignStore = await Store.open({ path: benignDb })
    seed(benignStore, { requestId: "b-1", tags: { feature: "chat" } })
    benignStore.close()

    const hostileDir = tempDir()
    const hostileDb = join(hostileDir, "usage.db")
    const hostileStore = await Store.open({ path: hostileDb })
    seed(hostileStore, { requestId: "h-1", tags: HOSTILE })
    seed(hostileStore, { requestId: "h-2", tags: { long: LONG } })
    hostileStore.close()

    const benign = await run(["usage", "export", ...cliBase(benignDir, benignDb)], benignDir)
    const hostile = await run(["usage", "export", ...cliBase(hostileDir, hostileDb)], hostileDir)
    expect(benign.code).toBe(0)
    expect(hostile.code).toBe(0)

    // Expected line counts are external: 1 header + the number of seeded events.
    expect(csvLines(benign.stdout)).toHaveLength(1 + 1)
    expect(csvLines(hostile.stdout)).toHaveLength(1 + 2)
    // A benign baseline exists so "no injection" cannot be satisfied by writing
    // nothing at all: same shape, same single-line records, only the values differ.
    expect(csvLines(hostile.stdout).some((line) => line.trim() === FORGED)).toBe(false)
    expect(hostile.stdout).toContain(`feature=x\\n${FORGED}`)
    // The 300-character value is capped at 256 code points by `sanitizeTags`
    // (which this test bypassed by inserting through the store), so the cell here
    // holds all 300 — either way the record stays one line.
    expect(csvLines(hostile.stdout).filter((line) => line.includes("LLLL")).length).toBe(1)

    const plain = await run(["usage", "summary", "--by-tag", ...cliBase(benignDir, benignDb)], benignDir)
    const injected = await run(["usage", "summary", "--by-tag", ...cliBase(hostileDir, hostileDb)], hostileDir)
    expect(plain.code).toBe(0)
    expect(injected.code).toBe(0)
    // The forged sentence can never be a whole line of the table (it is escaped
    // inside a cell), and each database contributes exactly one `feature=` row.
    expect(
      normalize(injected.stdout)
        .split("\n")
        .some((line) => line.trim() === FORGED),
    ).toBe(false)
    expect(injected.stdout).toContain(`feature=x\\n${FORGED}`)
    expect(normalize(plain.stdout).split("\n").filter((line) => line.includes("feature=chat"))).toHaveLength(1)
    expect(normalize(injected.stdout).split("\n").filter((line) => line.includes("feature="))).toHaveLength(1)
  })

  it("no other host/provider cell may split a record either (new in G81)", async () => {
    // `model` comes from the upstream response, `session_id`/`error_code` from
    // the host and the failure: all arbitrary text that lands in a cell. Before
    // this card only the `tags` cell was neutralised (EVO-G82); a newline in any
    // of these produced a record spanning two physical lines — measured by
    // running this assertion against the pre-change writer (card report, A6).
    //
    // The app id stays `g81-app` because the read path is scoped to it; the
    // hostile text goes in the columns that are not the scope key.
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, {
      requestId: "split-1",
      modelActual: 'model,"x"\ny',
      sessionId: "sess\ninjected",
      status: "error",
      errorCode: "err\ncode",
    })
    store.close()

    const exported = await run(["usage", "export", ...cliBase(dir, db)], dir)
    expect(exported.code).toBe(0)
    const lines = csvLines(exported.stdout)
    expect(lines).toHaveLength(1 + 1)
    const fields = parseCsvLine(lines[1]!)
    expect(fields[USAGE_CSV_COLUMNS.indexOf("model")]).toBe('model,"x"\\ny')
    expect(fields[USAGE_CSV_COLUMNS.indexOf("session_id")]).toBe("sess\\ninjected")
    expect(fields[USAGE_CSV_COLUMNS.indexOf("error_code")]).toBe("err\\ncode")
    expect(fields).toHaveLength(USAGE_CSV_COLUMNS.length)
    // The row-level invariant, stated once: no line of the artifact contains a
    // character that can end a physical line.
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
    }
  })

  it("neutralises the same characters the tag renderer does (one implementation)", () => {
    expect(csvField("a\nb")).toBe("a\\nb")
    expect(csvField("a\r\nb")).toBe("a\\r\\nb")
    expect(csvField("a\u2028b")).toBe("a?b")
    expect(csvField("a\u0000b")).toBe("a?b")
    expect(csvField("a,b")).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField(undefined)).toBe("")
    // Cross-check against the G82 renderer itself: the CSV cell text is that
    // function's output, not a second copy of the policy.
    for (const value of ["a\nb", "a\r\nb", "a\u2028b", "a\u0000b", "plain"]) {
      const expected = sanitizeTagForDisplay(value)
      expect(csvField(value)).toBe(/[",]/.test(expected) ? `"${expected.replace(/"/g, '""')}"` : expected)
    }
  })
})

describe("EVO-G81 A4 — the contract names every new column and its type", () => {
  // Read at run time from the source tree; the *artifact* check (does `dist`
  // really export the constant / print the header?) is done by grepping the
  // built `dist` in the card report, per the repo's G11 rule.
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/interfaces.md", import.meta.url)), "utf8")

  it("documents the seven appended columns with a type and a meaning", () => {
    for (const column of USAGE_CSV_COLUMNS.slice(15)) {
      // Back-ticked, so prose that merely mentions the name is not enough.
      expect(doc).toContain(`\`${column}\``)
    }
    expect(doc).toContain("`cost_microusd`")
    expect(doc).toContain("`request_id`")
    // Types and the reconciliation precision are stated, not implied.
    expect(doc).toContain("integer")
    expect(doc).toContain("微美元")
    expect(doc).toContain("对账精度")
    // The frozen prefix is described as source-level, and the *publicly
    // exported* constants are named: check the doc does not promise an import
    // that `dist/cli.d.mts` does not provide (the G11 failure mode).
    expect(doc).toContain("USAGE_CSV_FROZEN_COLUMNS")
    expect(doc).toContain("`USAGE_CSV_COLUMNS`")
    expect(doc).toContain("`USAGE_CSV_HEADER`")
    expect(doc).toContain("不在 `mik/cli` 的公开导出里")
    // The G75 section keeps the `第 15 列` fact it owned, and the G81 section
    // supersedes it in the same document (no silently rewritten history).
    expect(doc).toContain("第 15 列")
    expect(doc).toContain("EVO-G81")
    // The identity the user joins on is named together with its route.
    expect(doc).toContain("/api/usage/logs/:id")
  })

  it("states the row-structure invariant as a property of the row, not of `tags`", () => {
    expect(doc).toContain("单条记录恰好一行")
    expect(doc).toContain("sanitizeTagForDisplay")
  })
})

describe("EVO-G81 — the frozen contract", () => {
  it("keeps the fifteen pre-existing column names and order byte-for-byte", () => {
    // A literal, not `USAGE_CSV_HEADER` compared with itself: this is the G75
    // artifact's header, re-typed by hand.
    expect(USAGE_CSV_FROZEN_HEADER).toBe(
      "ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms,tags",
    )
    expect(USAGE_CSV_FROZEN_COLUMNS).toHaveLength(15)
    expect(USAGE_CSV_HEADER.startsWith(`${USAGE_CSV_FROZEN_HEADER},`)).toBe(true)
    // Exactly seven appended columns, in a fixed order.
    expect(USAGE_CSV_COLUMNS.slice(15)).toEqual([
      "request_id",
      "session_id",
      "first_token_ms",
      "is_streaming",
      "error_code",
      "pricing_model",
      "cost_microusd",
    ])
    expect(USAGE_CSV_COLUMNS).toHaveLength(22)
    // The one place the product's header meets the external literal, so the
    // three `--out`/empty-db cases above compare against a frozen string (R231).
    expect(USAGE_CSV_HEADER).toBe(G81_CSV_HEADER_LITERAL)
  })

  it("exports an empty database as a header and nothing else", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    store.close()

    const exported = await run(["usage", "export", ...cliBase(dir, db)], dir)
    expect(exported.code).toBe(0)
    const lines = csvLines(exported.stdout)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(G81_CSV_HEADER_LITERAL)

    const target = join(dir, "out", "empty.csv")
    const wrote = await run(["usage", "export", "--out", target, ...cliBase(dir, db)], dir)
    expect(wrote.code).toBe(0)
    expect(normalize(readFileSync(target, "utf8"))).toBe(`${G81_CSV_HEADER_LITERAL}\n`)
  })

  it("prices the cost columns from the integer micro-USD, never a float sum", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    // 0.1 + 0.2 in float is 0.30000000000000004; in micro-USD it is exactly
    // 100000 + 200000 = 300000, and the CSV must show the exact integers.
    seed(store, { requestId: "fp-1", ts: 1, cost: { usd: 0.1, low: 0.1, high: 0.1, basis: "flat", source: "modelsdev" } })
    seed(store, { requestId: "fp-2", ts: 2, cost: { usd: 0.2, low: 0.2, high: 0.2, basis: "flat", source: "modelsdev" } })
    store.close()

    const exported = await run(["usage", "export", ...cliBase(dir, db)], dir)
    const records = csvRecords(exported.stdout)
    expect(records.map((record) => record.cost_microusd)).toEqual(["100000", "200000"])
    expect(records.reduce((total, record) => total + Number(record.cost_microusd), 0)).toBe(300000)
    expect(records.map((record) => record.cost_usd)).toEqual(["0.100000", "0.200000"])
  })
})
