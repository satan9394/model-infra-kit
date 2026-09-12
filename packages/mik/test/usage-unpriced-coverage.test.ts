import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { USAGE_CSV_HEADER } from "../src/cli/csv.js"
import { i18nKeys, tr } from "../src/cli/i18n.js"
import { en } from "../src/cli/i18n/en.js"
import { zh } from "../src/cli/i18n/zh.js"
import { main } from "../src/cli/index.js"
import { Store } from "../src/store/database.js"
import type { CostInfo } from "../src/types.js"
import { UsageService } from "../src/usage/service.js"

/**
 * EVO-G74 — "unpriced coverage" in `usage summary`.
 *
 * The card's whole risk is noise and self-congratulation: a segment that always
 * prints tells a healthy user nothing, and an assertion like "the output
 * contains a Chinese word" can hold before *and* after the change (G43). Every
 * assertion below therefore names a **concrete number or model id**, so the
 * same assertion is red against the pre-change build — see
 * `.tmp/impl-G74.md` for the probe that evaluates these exact patterns against
 * the pre-change `dist` output.
 *
 * Numbers are hand-computed in each test and written into the expectation as
 * literals; nothing is derived from the code under test.
 */

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g74-"))
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

/** In-process CLI run. `MIK_LANG` defaults to `en`; the host locale is never read. */
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
  return { dir, db, base: ["--offline", "--db", db, "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")] }
}

interface SeedSpec {
  id: string
  model: string
  source: CostInfo["source"]
  input?: number
  output?: number
  usd?: number
  ts?: number
}

async function seed(dbPath: string, specs: readonly SeedSpec[], appId = "cli-app"): Promise<void> {
  const store = await Store.open({ path: dbPath })
  const usage = new UsageService({ store, appId, enabled: true })
  specs.forEach((spec, index) => {
    usage.record({
      requestId: spec.id,
      ts: spec.ts ?? Date.parse("2026-09-01T10:00:00.000Z") + index * 1000,
      source: "generate",
      providerId: "deepseek",
      modelRequested: `deepseek:${spec.model}`,
      modelActual: spec.model,
      usage: { input: spec.input ?? 0, output: spec.output ?? 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usd: spec.usd ?? 0, low: spec.usd ?? 0, high: spec.usd ?? 0, basis: "flat", source: spec.source },
      latencyMs: 100,
      status: "ok",
      isStreaming: false,
    })
  })
  store.close()
}

const APP = ["--app-id", "cli-app"]

/**
 * The pre-change CSV header, byte-for-byte, captured from the 0.2.14 `dist`
 * build before this card touched anything (`.tmp/g74-baseline/export-header.txt`).
 *
 * It is deliberately a **literal** rather than `USAGE_CSV_HEADER`: comparing the
 * command output against the very constant the command prints would pass no
 * matter how the header changed.
 */
const PRE_CHANGE_CSV_HEADER =
  "ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms"

/**
 * The pre-change `usage summary` on an empty database, byte-for-byte
 * (`.tmp/g74-baseline/summary-empty-en.txt`). Any new segment that fired on a
 * healthy/empty install would break this.
 */
const PRE_CHANGE_EMPTY_SUMMARY =
  "Range - → - · app=cli-app\n" +
  "\n" +
  "Requests        0\n" +
  "Successes       0\n" +
  "Failures        0\n" +
  "Success rate    0.0%\n" +
  "Cost (USD)      0.0000\n" +
  "Cost range      0.0000 – 0.0000\n" +
  "Input tokens    0\n" +
  "Output tokens   0\n" +
  "Cache read      0\n" +
  "Cache write     0\n" +
  "Reasoning       0\n" +
  "Cache hit rate  0.0%\n" +
  "Avg latency     0 ms\n" +
  "First token     0 ms\n"

/**
 * Seven requests, four of them unpriced. Hand-computed:
 *   requests   4 / 7                  = 57.142…%  → 57.1%
 *   tokens     2500+1000+400+10 = 3910
 *   total tok  1000+2500+1000+3000+100+400+10 = 8010
 *              3910 / 8010           = 48.813…%  → 48.8%
 *   top-N      gpt-4o 3500 (2 req), mixed-model 400, o3-mini 10
 *
 * `m-priced-2` uses `pricing_source="provider"` (the endpoint's own billed
 * figure, EVO-G73): it is **priced** and must never be counted as unpriced.
 */
const MIXED: readonly SeedSpec[] = [
  { id: "m-1", model: "m-priced-1", source: "modelsdev", input: 1000, usd: 0.01 },
  { id: "m-2", model: "gpt-4o", source: "missing", input: 2000, output: 500 },
  { id: "m-3", model: "gpt-4o", source: "missing", input: 1000 },
  { id: "m-4", model: "m-priced-2", source: "provider", input: 3000, usd: 0.5 },
  { id: "m-5", model: "mixed-model", source: "modelsdev", input: 100, usd: 0.001 },
  { id: "m-6", model: "mixed-model", source: "missing", input: 400 },
  { id: "m-7", model: "o3-mini", source: "missing", input: 10 },
]

describe("EVO-G74 — unpriced coverage in `usage summary`", () => {
  it("A1/A3 — prints hand-computed shares and only unpriced models in the top list", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, MIXED)
    const result = await run(["usage", "summary", ...base, ...APP], dir)
    expect(result.code).toBe(0)

    // A3: the denominator is the request count (4 of 7) and the hand-computed
    // token total (3,910 of 8,010) — not "some number greater than zero".
    expect(result.stdout).toMatch(/Unpriced requests\s+4 \/ 7 \(57\.1%\)/)
    expect(result.stdout).toMatch(/Unpriced tokens\s+3,910 \/ 8,010 \(48\.8%\)/)

    // A1: top-N lists exactly the unpriced models, most tokens first.
    expect(result.stdout).toContain("gpt-4o")
    expect(result.stdout).toContain("mixed-model")
    expect(result.stdout).toContain("o3-mini")
    // ...and no priced model leaks in, including the `provider`-priced one.
    expect(result.stdout).not.toContain("m-priced-1")
    expect(result.stdout).not.toContain("m-priced-2")

    // A copy-pasteable fix, one per listed model.
    expect(result.stdout).toContain("Fix: mik pricing set gpt-4o --input <usd/M> --output <usd/M>")

    // The pre-existing lines keep their content, and the new segment sits after them.
    expect(result.stdout).toContain("Requests        7")
    expect(result.stdout).toContain("Cost (USD)      0.5110")
    expect(result.stdout.indexOf("First token")).toBeLessThan(result.stdout.indexOf("Unpriced coverage"))
  })

  it("A1 — orders the top list by tokens and caps it at five models", async () => {
    const { dir, db, base } = sandbox()
    await seed(
      db,
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        id: `cap-${n}`,
        model: `cap-model-${n}`,
        source: "missing" as const,
        input: n * 100,
      })),
    )
    const result = await run(["usage", "summary", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/Unpriced requests\s+7 \/ 7 \(100\.0%\)/)
    for (const included of ["cap-model-7", "cap-model-6", "cap-model-5", "cap-model-4", "cap-model-3"]) {
      expect(result.stdout, included).toContain(included)
    }
    expect(result.stdout).not.toContain("cap-model-2")
    expect(result.stdout).not.toContain("cap-model-1")
    // Ordering: the heaviest model is listed before the lightest one shown.
    expect(result.stdout.indexOf("cap-model-7")).toBeLessThan(result.stdout.indexOf("cap-model-3"))
    expect(result.stdout.split("Fix: mik pricing set").length - 1).toBe(5)
  })

  it("A2 — says nothing at all when every request is priced", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, [
      { id: "p-1", model: "priced-a", source: "modelsdev", input: 100, usd: 0.01 },
      { id: "p-2", model: "priced-b", source: "provider", input: 200, usd: 0.02 },
      { id: "p-3", model: "priced-c", source: "override", input: 300, usd: 0.03 },
      { id: "p-4", model: "priced-d", source: "openrouter", input: 400, usd: 0.04 },
      { id: "p-5", model: "priced-e", source: "fallback", input: 500, usd: 0.05 },
    ])
    const result = await run(["usage", "summary", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    // The summary itself is still there...
    expect(result.stdout).toContain("Requests        5")
    expect(result.stdout).toContain("Cost (USD)      0.1500")
    // ...and the coverage block is absent, in both languages, by every phrase it owns.
    for (const phrase of ["Unpriced", "未定价", "Top unpriced", "pricing set"]) {
      expect(result.stdout, phrase).not.toContain(phrase)
    }
    expect(result.stdout.match(/Unpriced coverage/g)).toBeNull()
  })

  it("A2 — an empty range prints the pre-change summary byte-for-byte", async () => {
    const { dir, base } = sandbox()
    const result = await run(["usage", "summary", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(`${result.stdout}\n`).toBe(PRE_CHANGE_EMPTY_SUMMARY)
  })

  it("edge — all unpriced is 100.0% twice over and does not divide by zero", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, [
      { id: "u-1", model: "unpriced-a", source: "missing", input: 700, output: 30 },
      { id: "u-2", model: "unpriced-b", source: "missing", input: 20 },
    ])
    const result = await run(["usage", "summary", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/Unpriced requests\s+2 \/ 2 \(100\.0%\)/)
    expect(result.stdout).toMatch(/Unpriced tokens\s+750 \/ 750 \(100\.0%\)/)
    expect(result.stdout).toContain("unpriced-a")
    expect(result.stdout).toContain("unpriced-b")
  })

  it("edge — a partly-priced model is reported as partly unpriced, never as priced", async () => {
    const { dir, db, base } = sandbox()
    // `mixed-model`: one priced request (100 tok) + two unpriced (400 + 100).
    // `other-model`: one unpriced request (50 tok).
    // Hand-computed: requests 3 / 4 = 75.0%; tokens 550 / 650 = 84.615…% → 84.6%
    await seed(db, [
      { id: "h-1", model: "mixed-model", source: "modelsdev", input: 100, usd: 0.001 },
      { id: "h-2", model: "mixed-model", source: "missing", input: 400 },
      { id: "h-3", model: "mixed-model", source: "missing", input: 100 },
      { id: "h-4", model: "other-model", source: "missing", input: 50 },
    ])
    const result = await run(["usage", "summary", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/Unpriced requests\s+3 \/ 4 \(75\.0%\)/)
    expect(result.stdout).toMatch(/Unpriced tokens\s+550 \/ 650 \(84\.6%\)/)
    // The row counts only the two unpriced requests of that model (500 tokens),
    // so deduplicating by model cannot make it look fully priced.
    expect(result.stdout).toMatch(/mixed-model\s+2\s+500/)
  })

  it("A5 — localizes the block into Chinese and keeps the numbers and ids literal", async () => {
    const { dir, db, base } = sandbox()
    await seed(db, MIXED)
    const result = await run(["usage", "summary", ...base, ...APP], dir, { MIK_LANG: "zh" })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("未定价覆盖")
    expect(result.stdout).toContain("未定价最多的模型")
    expect(result.stdout).toMatch(/未定价请求\s+4 \/ 7 \(57\.1%\)/)
    expect(result.stdout).toMatch(/未定价 token\s+3,910 \/ 8,010 \(48\.8%\)/)
    expect(result.stdout).toContain("修法：mik pricing set gpt-4o --input <usd/M> --output <usd/M>")
    expect(result.stdout).not.toContain("Unpriced")
  })

  it("A5 — both dictionaries define the new keys (286 → 294) with equal key sets", async () => {
    const NEW_KEYS = [
      "usage.summary.unpriced.title",
      "usage.summary.unpriced.requests",
      "usage.summary.unpriced.tokens",
      "usage.summary.unpriced.topModels",
      "usage.summary.unpriced.header.model",
      "usage.summary.unpriced.header.requests",
      "usage.summary.unpriced.header.tokens",
      "usage.summary.unpriced.fix",
    ]
    for (const key of NEW_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(zh, key), `zh missing ${key}`).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(en, key), `en missing ${key}`).toBe(true)
      expect(tr("zh", key), key).not.toBe("")
      expect(tr("en", key), key).not.toBe("")
    }
    expect(Object.keys(zh)).toHaveLength(294)
    expect(Object.keys(en)).toHaveLength(294)
    expect([...Object.keys(zh)].sort()).toEqual([...Object.keys(en)].sort())
    expect(i18nKeys()).toHaveLength(294)
    expect(tr("en", "usage.summary.unpriced.title")).toBe("Unpriced coverage")
    expect(tr("zh", "usage.summary.unpriced.title")).toBe("未定价覆盖")
  })

  it("A4 — the CSV header is byte-identical to the pre-change header", async () => {
    // The literal is the pre-change header, so this cannot pass by comparing the
    // output against the constant that produced it.
    expect(USAGE_CSV_HEADER).toBe(PRE_CHANGE_CSV_HEADER)

    const { dir, db, base } = sandbox()
    await seed(db, MIXED)
    const en = await run(["usage", "export", "--format", "csv", ...base, ...APP], dir, { MIK_LANG: "en" })
    const zhRun = await run(["usage", "export", "--format", "csv", ...base, ...APP], dir, { MIK_LANG: "zh" })
    expect(en.code).toBe(0)
    expect(zhRun.code).toBe(0)
    expect(en.stdout.split("\n")[0]).toBe(PRE_CHANGE_CSV_HEADER)
    expect(zhRun.stdout.split("\n")[0]).toBe(PRE_CHANGE_CSV_HEADER)
    expect(zhRun.stdout).toBe(en.stdout)
    expect(en.stdout.trimEnd().split("\n")).toHaveLength(MIXED.length + 1)

    const target = join(dir, "out", "usage.csv")
    const wrote = await run(["usage", "export", "--format", "csv", "--out", target, ...base, ...APP], dir)
    expect(wrote.code).toBe(0)
    expect(readFileSync(target, "utf8").split("\n")[0]).toBe(PRE_CHANGE_CSV_HEADER)
  })

  it("boundary — a rolled-up range is unmeasurable, so the block stays silent", async () => {
    // `usage_daily_rollups` stores no `pricing_source`, so an unpriced day that
    // was folded away cannot be measured. The block is silent rather than
    // guessing; `Requests` still counts the rolled-up rows. Documented boundary,
    // pinned here so it stays a decision instead of becoming an accident.
    const { dir, db, base } = sandbox()
    await seed(db, [
      { id: "r-1", model: "rolled-unpriced", source: "missing", input: 900, ts: Date.now() - 3 * 86_400_000 },
      { id: "r-2", model: "today-priced", source: "modelsdev", input: 100, usd: 0.01, ts: Date.now() },
    ])
    const store = await Store.open({ path: db })
    new UsageService({ store, appId: "cli-app", enabled: true }).rollupAndPrune(Date.now())
    store.close()

    const result = await run(["usage", "summary", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Requests        2")
    expect(result.stdout).not.toContain("Unpriced")
  })
})
