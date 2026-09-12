import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseCliArgs } from "../src/cli/args.js"
import { openContext } from "../src/cli/context.js"
import { main } from "../src/cli/index.js"
import { handleLine } from "../src/cli/repl.js"
import { Store } from "../src/store/database.js"
import type { UsageEvent } from "../src/types.js"

/**
 * EVO-G88 — the three "the tool did something you were not told about" leftovers.
 *
 * A. One charge, three surfaces (CLI / REPL / dashboard) must use **one** precision
 *    rule. The CLI has had it since EVO-G85 (`formatUsageMoney`: four decimals when
 *    the micro-USD total has nothing below 1e-4, six when it does). The REPL and the
 *    dashboard still rounded to four, so `0.000654` in the terminal was `$0.0007`
 *    next to it. A1 below pins the CLI and REPL bytes for one amount.
 * B. Re-running `init` without `--cache-dir` rewrote the file and dropped the stored
 *    value, so the install silently fell back to the home cache. A2 is the exact
 *    sequence: write with the flag, re-run without it.
 * C. `trends --to <date>` with no `--from`/`--days` invented a 30-day lower bound
 *    and printed two concrete dates as if both had been typed. A3/A4 cover the
 *    notice and the `--days` boundaries that had no test at all.
 *
 * Every expectation here is an **external literal** — a hand-typed path, a
 * hand-typed sentence, the pre-change four-decimal string — never a value recomputed
 * through the code under test (R231).
 */

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g88-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

interface Captured {
  code: number
  stdout: string
  stderr: string
}

/** In-process CLI run, offline, `MIK_LANG=en`, no inherited cache-dir override. */
async function run(args: readonly string[], cwd: string): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const env: NodeJS.ProcessEnv = { ...process.env, MIK_LANG: "en" }
  delete env.MIK_CACHE_DIR
  const code = await main(args, { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, cwd, env, interactive: false })
  return { code, stdout: out.join("\n"), stderr: err.join("\n") }
}

function cliBase(dir: string, db: string): string[] {
  return ["--offline", "--db", db, "--app", "g88-app", "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")]
}

function seed(store: Store, overrides: Partial<UsageEvent> = {}): void {
  const event: UsageEvent = {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "g88-app",
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

/** 340 µ$ — a real amount whose four-decimal rendering (`0.0003`) loses it. */
const MICRO_REMAINDER_USD = 0.00034
/** What every surface must print for it from this card on. */
const MICRO_REMAINDER_TEXT = "0.000340"
/** What the CLI's usage surfaces printed before EVO-G85, and the REPL/dashboard until now. */
const PRE_CHANGE_TEXT = "0.0003"

async function seedOne(dir: string, db: string, usd: number): Promise<void> {
  const store = await Store.open({ path: db })
  seed(store, { requestId: "g88-one", ts: Date.now(), cost: { usd, low: usd, high: usd, basis: "flat", source: "manual" } })
  store.close()
}

/**
 * Every `COST USD` cell of a `usage logs` table, taken from the table's own bytes
 * (`…  0.000340  manual  …`). Substring checks are useless here: `0.000340`
 * *contains* `0.0003`, so only the whole cell can tell the two renderings apart.
 */
function costCells(stdout: string): string[] {
  return [...stdout.matchAll(/  (0\.\d+)  (?:manual|modelsdev|missing)/g)].map((match) => match[1]!)
}

describe("EVO-G88 A1 — CLI and REPL print one amount with the same digits", () => {
  it("REPL `/chat` renders the call cost through the usage-money rule", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    await seedOne(dir, db, MICRO_REMAINDER_USD)

    // The CLI side of the same amount, so the two are compared as bytes below.
    const logs = await run(["usage", "logs", ...cliBase(dir, db)], dir)
    expect(logs.code).toBe(0)
    // The cell, whole: the pre-change renderer put `0.0003` here.
    expect(costCells(logs.stdout)).toEqual([MICRO_REMAINDER_TEXT])
    expect(costCells(logs.stdout)).not.toEqual([PRE_CHANGE_TEXT])

    // The REPL side: the real `chatScript` path, with the hub's provider calls
    // stubbed. The typed hole is the minimal one that reaches the io.out line —
    // the assertions below are on that line's bytes.
    const parsed = parseCliArgs(["--db", db, "--app-id", "g88-app", "--offline", "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")])
    const out: string[] = []
    const err: string[] = []
    const options = { io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) }, env: { ...process.env, MIK_LANG: "en" }, interactive: false }
    const context = await openContext(parsed, options)
    try {
      vi.spyOn(context.hub.providers, "defaultModel").mockReturnValue({ providerId: "mock", modelId: "mock-model" } as never)
      vi.spyOn(context.hub, "generate").mockResolvedValue({
        text: "hello",
        model: { actual: "mock-model" },
        cost: { usd: MICRO_REMAINDER_USD, source: "manual" },
      } as never)

      await handleLine({ parsed, options, context }, "en", () => {}, "/chat hi")

      // The reply text is printed only on the success path, immediately before the
      // cost line: this pins that the line below came out of `chatScript` itself and
      // not out of its error branch.
      expect(out[0]).toBe("hello")
      // Hand-typed sentence, the same digits the CLI printed above. Asserted whole
      // (not as a substring): `cost 0.0003 ·` would otherwise pass as a prefix.
      const chatLine = out.find((line) => line.startsWith("cost "))
      expect(chatLine).toBe("cost 0.000340 · model mock-model · source manual")
      expect(chatLine).not.toBe("cost 0.0003 · model mock-model · source manual")
    } finally {
      await context.close()
    }
  })
})

describe("EVO-G88 A2 — a re-run of `init` keeps the stored `cacheDir`", () => {
  it("preserves the value written by the first run, and lets a new flag win", async () => {
    const dir = tempDir()
    const configPath = join(dir, "mik.config.json")
    const db = join(dir, "usage.db")
    const storedCache = join(dir, "cache-stored")
    const typedCache = join(dir, "cache-typed")
    const initArgs = ["init", "--yes", "--offline", "--file", configPath, "--db", db, "--app-id", "g88"]

    // 1. The EVO-G84 path: the flag is written.
    const first = await run([...initArgs, "--cache-dir", storedCache], dir)
    expect(first.code).toBe(0)
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ cacheDir: storedCache })

    // 2. The EVO-G88 defect, replayed: re-run with no `--cache-dir`. `--force` is
    //    what makes this a re-run rather than the `init.exists` guard.
    const second = await run([...initArgs, "--force"], dir)
    expect(second.code).toBe(0)
    const afterRerun = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
    // External literal: the path typed in step 1, not a value read back earlier.
    expect(afterRerun.cacheDir).toBe(storedCache)
    // The kept value is also on screen, so "the tool kept it" is not something the
    // user has to infer from a file.
    expect(second.stdout).toContain(`cache  ${storedCache}`)
    // The other fields are still rewritten from the flags, as before.
    expect(afterRerun.appId).toBe("g88")
    expect(afterRerun.db).toBe(db)

    // 3. A flag on the re-run still wins over the stored value.
    const third = await run([...initArgs, "--force", "--cache-dir", typedCache], dir)
    expect(third.code).toBe(0)
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ cacheDir: typedCache })
    expect(third.stdout).toContain(`cache  ${typedCache}`)

    // 4. Without a flag, an env value or a stored file value there is nothing to
    //    keep, so no key is invented (the guard is not "always write something").
    const fresh = join(dir, "fresh.config.json")
    const plain = await run(["init", "--yes", "--offline", "--file", fresh, "--db", db, "--app-id", "g88"], dir)
    expect(plain.code).toBe(0)
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(readFileSync(fresh, "utf8")), "cacheDir")).toBe(false)
    expect(plain.stdout).not.toContain("cache  ")

    // 5. A corrupt config file must not make init fail or invent a value.
    const broken = join(dir, "broken.config.json")
    writeFileSync(broken, "{ not json", "utf8")
    const overBroken = await run(["init", "--yes", "--offline", "--force", "--file", broken, "--db", db, "--app-id", "g88"], dir)
    expect(overBroken.code).toBe(0)
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(readFileSync(broken, "utf8")), "cacheDir")).toBe(false)
  })
})

describe("EVO-G88 A3 — an invented lower bound is on screen", () => {
  it("`trends --to <date>` says the lower bound is the tool's own default", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    await seedOne(dir, db, MICRO_REMAINDER_USD)

    const result = await run(["usage", "trends", "--to", "2026-09-08", ...cliBase(dir, db)], dir)
    expect(result.code).toBe(0)
    // Hand-typed sentence (duplicated from the dictionary on purpose, R231).
    expect(result.stdout).toContain(
      "Note: with no --from this command fills the lower bound in itself, 30 days before --to; usage summary and usage logs cover the whole history by default.",
    )

    // The number in the sentence is the window that was actually queried. A plain
    // `--to` date means "the whole of that day" (advanced to the next midnight), so
    // the header prints that day as the upper bound and its 30-days-earlier
    // midnight as the lower one — asserted as literals for the date typed above.
    const header = result.stdout.match(/Range (\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})/)
    expect(header).not.toBeNull()
    expect(header![1]).toBe("2026-08-10")
    expect(header![2]).toBe("2026-09-08")
    expect((Date.parse("2026-09-09T00:00:00Z") - Date.parse(`${header![1]}T00:00:00Z`)) / 86_400_000).toBe(30)

    // Both bounds typed → nothing is implied, and the notice must stay off.
    const explicit = await run(["usage", "trends", "--from", "2026-08-09", "--to", "2026-09-08", ...cliBase(dir, db)], dir)
    expect(explicit.code).toBe(0)
    expect(explicit.stdout).not.toContain("fills the lower bound in itself")
    // A typed `--days` is the user's own choice of span, so it is not an implied
    // bound either: the all-default notice is the only one that may appear.
    const typedDays = await run(["usage", "trends", "--days", "7", ...cliBase(dir, db)], dir)
    expect(typedDays.code).toBe(0)
    expect(typedDays.stdout).not.toContain("fills the lower bound in itself")
  })
})

describe("EVO-G88 A4 — `--days N` boundaries", () => {
  it("`--days 1` is a one-day window and drops older usage", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    // Today: 340 µ$; three days ago: a value that must not be inside a 1-day window.
    seed(store, { requestId: "today", ts: Date.now(), cost: { usd: 0.00034, low: 0.00034, high: 0.00034, basis: "flat", source: "manual" } })
    seed(store, {
      requestId: "old",
      ts: Date.now() - 3 * 86_400_000,
      cost: { usd: 0.000777, low: 0.000777, high: 0.000777, basis: "flat", source: "manual" },
    })
    store.close()

    const result = await run(["usage", "trends", "--days", "1", ...cliBase(dir, db)], dir)
    expect(result.code).toBe(0)
    // The narrow window is visible as one day: the header opens and closes on today.
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
    expect(result.stdout).toContain(`Range ${stamp} → ${stamp}`)
    expect(result.stdout).toContain(MICRO_REMAINDER_TEXT)
    // The third-day row is out of the window: it is absent, not merely reformatted.
    expect(result.stdout).not.toContain("0.000777")
    // A typed span is not an implied bound (neither notice belongs here).
    expect(result.stdout).not.toContain("fills the lower bound in itself")
    expect(result.stdout).not.toContain("covers only the last")
  })

  it("accepts the documented maximum and rejects everything past it", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    await seedOne(dir, db, MICRO_REMAINDER_USD)

    // 3650 is the largest accepted value: a legitimate window, exit 0.
    const atMax = await run(["usage", "trends", "--days", "3650", ...cliBase(dir, db)], dir)
    expect(atMax.code).toBe(0)
    expect(atMax.stdout).not.toContain("--days must be an integer")

    // One past it, zero, a fraction and a huge value are all rejected by the
    // command's own range check, with the usage exit code.
    for (const value of ["3651", "0", "1.5", "999999999"]) {
      const rejected = await run(["usage", "trends", "--days", value, ...cliBase(dir, db)], dir)
      expect(rejected.code, `--days ${value}`).toBe(2)
      expect(rejected.stderr).toContain(`--days must be an integer between 1 and 3650, got ${value}.`)
    }

    // A negative value must be passed glued to the flag: `--days -3` is consumed by
    // the option parser first (it reads `-3` as another option) and never reaches
    // the range check. Both shapes exit 2; only the diagnostic differs.
    const spaced = await run(["usage", "trends", "--days", "-3", ...cliBase(dir, db)], dir)
    expect(spaced.code).toBe(2)
    expect(spaced.stderr).toContain("argument is ambiguous")
    const glued = await run(["usage", "trends", "--days=-3", ...cliBase(dir, db)], dir)
    expect(glued.code).toBe(2)
    expect(glued.stderr).toContain("--days must be an integer between 1 and 3650, got -3.")
  })

  it("rejects a non-numeric `--days` before any query runs", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    await seedOne(dir, db, MICRO_REMAINDER_USD)
    const result = await run(["usage", "trends", "--days", "abc", ...cliBase(dir, db)], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--days expects a number, got "abc".')
    // Nothing was queried: the range header and the table never printed.
    expect(result.stdout).not.toContain("Range ")
    expect(result.stdout).not.toContain("DATE")
  })
})
