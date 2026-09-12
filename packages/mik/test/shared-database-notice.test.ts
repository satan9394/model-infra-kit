import { mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { USAGE_CSV_HEADER } from "../src/cli/csv.js"
import { main } from "../src/cli/index.js"
import { Store } from "../src/store/database.js"
import { UsageService } from "../src/usage/service.js"
import { defaultDbPath } from "../src/util/paths.js"

/**
 * EVO-G64 — "this database is shared" in `usage summary`.
 *
 * Without `--db`, every project on the machine resolves to the same file
 * (`~/.model-infra-kit/usage.db`). That is deliberate — it is how several apps
 * total their spend together — but nothing in the output said so, so a caller
 * read a total with no way to learn that other applications wrote into it.
 *
 * **Two signals, which must stay distinguishable** (the amendment to this card):
 *
 * 1. **Known sharing** — the file holds `>= 2` app ids, so other applications
 *    demonstrably wrote into it. Count + names. Fires with or without `--db`.
 * 2. **Possible sharing** — the caller named no database at all, so the figures
 *    come from the machine-wide default that any other project with the same
 *    defaults also writes into. Path only: the reported case (two projects that
 *    both keep the default `app_id`) is a single app id in the file, and no
 *    evidence of it exists, so claiming a count or a name would be a lie.
 *    Silent whenever `--db` / `MIK_DB` / a config entry named the file.
 *
 * The whole risk of this card is **noise plus a vacuous test**: an assertion
 * like "the output mentions the database" or "it contains a Chinese word" holds
 * before *and* after the change (G43), and a notice that fires on every install
 * is worse than none (G74/G75/G77). Every expectation below therefore names a
 * **literal**: the temp file path, the app count, and the app ids in sorted
 * order — none of them derived from the code under test, and all of them
 * verified red against the 0.2.21 build before this card (see
 * `.tmp/impl-G64.md`).
 *
 * Two of them are **guards for constraints this card must not break**, and are
 * therefore expected to be green before the change as well: the default
 * database path (A2) and the `usage export` header (A3). They are labelled as
 * guards where they appear, so "would this have been red?" is answerable per
 * assertion instead of per file.
 *
 * Temp directories are left in the OS temp dir on purpose: the repo's delete
 * rule sends every removal to the recycle bin, which is not worth doing here
 * (the EVO-G75 precedent).
 */

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g64-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  tempDirs.length = 0
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
  return {
    dir,
    db,
    base: ["--offline", "--db", db, "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")],
  }
}

interface SeedSpec {
  id: string
  usd: number
  input?: number
  ts?: number
}

/**
 * Write usage rows for one app, through the same `UsageService` the host uses.
 *
 * `appId` is per call on purpose: `UsageService` stamps its own id on every row
 * unless the caller is explicit, and the whole point here is several apps in
 * **one file**.
 */
async function seedApp(dbPath: string, appId: string, specs: readonly SeedSpec[]): Promise<void> {
  const store = await Store.open({ path: dbPath })
  const usage = new UsageService({ store, appId, enabled: true })
  specs.forEach((spec, index) => {
    usage.record({
      requestId: spec.id,
      ts: spec.ts ?? Date.parse("2026-09-01T10:00:00.000Z") + index * 1000,
      source: "generate",
      providerId: "deepseek",
      modelRequested: "deepseek:deepseek-chat",
      modelActual: "deepseek-chat",
      usage: { input: spec.input ?? 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usd: spec.usd, low: spec.usd, high: spec.usd, basis: "flat", source: "modelsdev" },
      latencyMs: 120,
      status: "ok",
      isStreaming: false,
    })
  })
  store.close()
}

/** Three apps in one file: two rows for `cli-app`, one each for two others. */
async function threeApps(db: string): Promise<void> {
  await seedApp(db, "cli-app", [
    { id: "c-1", usd: 0.005, input: 1000 },
    { id: "c-2", usd: 0.001, input: 1000 },
  ])
  await seedApp(db, "alpha-app", [{ id: "a-1", usd: 0.5, input: 10 }])
  await seedApp(db, "temp-x", [{ id: "t-1", usd: 0.25, input: 10 }])
}

/** Normalise line endings so a CRLF checkout compares equal to LF output (R99). */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

/**
 * Flags for a run that names **no** database — the implicit-default case.
 *
 * `--config` points at a path that does not exist, so `config.db` is absent too:
 * the resolution chain must fall through to `defaultDbPath()`.
 */
function noDbArgs(home: string, project: string): string[] {
  return [
    "usage",
    "summary",
    "--offline",
    "--cache-dir",
    join(home, "cache"),
    "--config",
    join(project, "mik.config.json"),
  ]
}

/**
 * Run `body` with `os.homedir()` pointed at a fresh temp directory, so the
 * **implicit** default database (`<home>/.model-infra-kit/usage.db`) is a file
 * this test owns instead of the developer's real one.
 *
 * `defaultDbPath()` calls `homedir()` on every read, and Node reads
 * `USERPROFILE` (Windows) / `HOME` (POSIX) from the live process environment —
 * there is no cached module state, so restoring the two variables in `finally`
 * is enough. Both names are set so the same test proves the same thing on all
 * three CI platforms (local-only green is not evidence: G26/R187).
 */
async function withFakeHome<T>(body: (home: string, db: string) => Promise<T>): Promise<T> {
  const home = tempDir()
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    return await body(home, join(home, ".model-infra-kit", "usage.db"))
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
  }
}

/**
 * `usage summary` on an **empty** database, byte-for-byte, captured from the
 * pre-change 0.2.21 build (`packages/mik/dist/cli.mjs`, built 2026-09-12
 * 04:12, i.e. before this card touched `src/`).
 *
 * It is a literal rather than a value recomputed by the code under test, and it
 * is the assertion that pins "no notice on a database with nothing in it".
 */
const PRE_CHANGE_EMPTY_HEADER = "Range - → - · app=cli-app"

/** Everything below the header, byte-for-byte from 0.2.23. */
const PRE_CHANGE_EMPTY_BODY =
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
  "Avg latency     -\n" +
  // EVO-G82 / audit-R232 F3: an empty range measured nothing, so this is `-`
  // (it was `0 ms` before the card; both latency lines now use one convention).
  "First token     -\n"

/**
 * The same empty summary after EVO-G78: the header line and its scope notice are
 * new, every figure line is the frozen literal above.
 */
const G78_EMPTY_SUMMARY =
  "Range all time (no --from/--to given) · app=cli-app\n" +
  "Note: with no --from/--to this command covers the whole history; usage trends covers only the last 30 days by default.\n" +
  PRE_CHANGE_EMPTY_BODY

/**
 * The published 15-column `usage export` header (A3), re-typed as a literal:
 * the 14 columns of 0.2.14 plus `tags` appended by EVO-G75. Comparing the
 * command output against `USAGE_CSV_HEADER` itself would pass no matter what
 * the header became, so both sides are literals here.
 */
const PRE_CHANGE_CSV_HEADER =
  "ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms,tags"

const PRE_CHANGE_CSV_COLUMNS = [
  "ts",
  "app_id",
  "provider",
  "model",
  "status",
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
  "cost_usd",
  "pricing_source",
  "pricing_basis",
  "latency_ms",
  "tags",
]

describe("EVO-G64 — the shared-database notice in `usage summary`", () => {
  it("A1 — one file, three apps: names the file, the count and every id", async () => {
    const { dir, db, base } = sandbox()
    await threeApps(db)

    const result = await run(["usage", "summary", "--app-id", "cli-app", ...base], dir)
    expect(result.code).toBe(0)

    // The line, verbatim: real count, ids in the order `apps()` owes them
    // (ascending). Any wording, cap or ordering change fails here. `--db` was
    // passed, so this is the *known* sharing line and it carries no path.
    expect(result.stdout).toContain(
      "Note: this database holds usage from 3 applications (alpha-app, cli-app, temp-x); use --app <id> to see just one of them.",
    )

    // The figures above it are still scoped to the calling app only: 2 of the
    // 4 rows in the file, 0.0050 + 0.0010 = 0.0060 — not the 0.7500 total.
    expect(result.stdout).toContain("Requests        2")
    expect(result.stdout).toContain("Cost (USD)      0.0060")
    expect(result.stdout).not.toContain("0.7500")

    // Appended last: every pre-existing line keeps its content and its offset.
    expect(result.stdout.indexOf("First token")).toBeLessThan(
      result.stdout.indexOf("Note: this database holds usage from"),
    )
    // An explicit `--db` means the caller chose the file, so the *possibility*
    // line must not appear here, and no path is echoed back at all.
    expect(result.stdout).not.toContain("no --db was given")
    expect(result.stdout).not.toContain(db)
  })

  it("A1 — the notice is about the file, so `--app` narrowing does not remove it", async () => {
    const { dir, db, base } = sandbox()
    await threeApps(db)

    const result = await run(["usage", "summary", "--app", "alpha-app", "--app-id", "cli-app", ...base], dir)
    expect(result.code).toBe(0)
    // The figures follow the filter...
    // EVO-G78 replaced `Range - → -` with the explicit `all time` wording.
    expect(result.stdout).toContain("Range all time (no --from/--to given) · app=alpha-app")
    expect(result.stdout).toContain("Requests        1")
    expect(result.stdout).toContain("Cost (USD)      0.5000")
    // ...and the sharing fact is unchanged, because it is a property of the file.
    expect(result.stdout).toContain("holds usage from 3 applications (alpha-app, cli-app, temp-x)")
  })

  it("A2 — one app in the file: not a word, not even the path", async () => {
    const { dir, db, base } = sandbox()
    await seedApp(db, "cli-app", [{ id: "only-1", usd: 0.002, input: 100 }])

    const result = await run(["usage", "summary", "--app-id", "cli-app", ...base], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Requests        1")
    expect(result.stdout).toContain("Cost (USD)      0.0020")
    // Neither signal: one app id (no known sharing) and `--db` was given (no
    // possibility line). This is the "do not nag" boundary of the card.
    expect(result.stdout).not.toContain("holds usage from")
    expect(result.stdout).not.toContain("no --db was given")
    // The resolved path is printed by these notices and by nothing else in
    // `usage summary`, so its absence is the sharpest form of "silent".
    expect(result.stdout).not.toContain(db)
  })

  it("A2 — an empty database keeps every pre-change figure line and changes only the header", async () => {
    const { dir, base } = sandbox()
    const result = await run(["usage", "summary", "--app-id", "cli-app", ...base], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain(PRE_CHANGE_EMPTY_HEADER)
    expect(`${result.stdout}\n`).toBe(G78_EMPTY_SUMMARY)
  })

  it("A2 — omitting `--db` still resolves to the machine-global database", async () => {
    // GUARD (green before the change, and it must stay green): this card must
    // not turn the default into per-project isolation. `openContext()` falls
    // back to this value when neither `--db`, `MIK_DB` nor a config entry sets
    // one, so the literal below *is* the default behaviour.
    expect(defaultDbPath()).toBe(join(homedir(), ".model-infra-kit", "usage.db"))
    // ...which is under the user's home, never under the current directory.
    expect(defaultDbPath().startsWith(homedir())).toBe(true)
  })

  it("A1/edge — an app whose history is entirely folded is still counted", async () => {
    const { dir, db, base } = sandbox()
    await seedApp(db, "cli-app", [{ id: "c-1", usd: 0.005, input: 100 }])
    await seedApp(db, "old-app", [{ id: "o-1", usd: 0.01, input: 100, ts: Date.now() - 5 * 86_400_000 }])

    const store = await Store.open({ path: db })
    new UsageService({ store, appId: "old-app", enabled: true }).rollupAndPrune(Date.now())
    store.close()

    // `usage_events` no longer holds a single `old-app` row — only
    // `usage_daily_rollups` does. A notice that read one table would say 1 app
    // here, which is exactly the "silently under-report sharing" bug.
    const result = await run(["usage", "summary", "--app-id", "cli-app", ...base], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("holds usage from 2 applications (cli-app, old-app)")
  })

  it("edge — more than five apps: the count stays exact while the list elides", async () => {
    const { dir, db, base } = sandbox()
    await seedApp(db, "cli-app", [{ id: "c-1", usd: 0.005, input: 100 }])
    for (const name of ["app-1", "app-2", "app-3", "app-4", "app-5"]) {
      await seedApp(db, name, [{ id: `${name}-row`, usd: 0.001, input: 10 }])
    }

    const result = await run(["usage", "summary", "--app-id", "cli-app", ...base], dir)
    expect(result.code).toBe(0)
    const line = normalize(result.stdout)
      .split("\n")
      .find((candidate) => candidate.startsWith("Note: this database holds usage from"))
    expect(line).toBe(
      "Note: this database holds usage from 6 applications (app-1, app-2, app-3, app-4, app-5, …); use --app <id> to see just one of them.",
    )
    // The elided sixth id is *not* silently presented as the whole list: the
    // count says 6 and the list ends with the ellipsis.
    expect(line?.endsWith("(app-1, app-2, app-3, app-4, app-5, …); use --app <id> to see just one of them.")).toBe(true)
  })

  it("A1/edge — the calling app has no rows of its own: the sharing fact still prints", async () => {
    const { dir, db, base } = sandbox()
    await seedApp(db, "alpha-app", [{ id: "a-1", usd: 0.5, input: 10 }])
    await seedApp(db, "beta-app", [{ id: "b-1", usd: 0.25, input: 10 }])

    // A second project that has never recorded anything still reads the shared
    // file: its own total is 0, and the notice is the only thing that says the
    // zeros are not "nothing ever happened on this machine".
    const result = await run(["usage", "summary", "--app-id", "fresh-app", ...base], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Requests        0")
    expect(result.stdout).toContain("holds usage from 2 applications (alpha-app, beta-app); use --app <id> to see just one of them.")
  })

  it("known boundary — one app_id used by several projects has no *evidence* line", async () => {
    await withFakeHome(async (home, db) => {
      await seedApp(db, "default", [{ id: "d-1", usd: 0.003, input: 100 }])

      /**
       * Two unrelated projects that both keep the default `app_id` are **one**
       * `app_id` in the file, and nothing stored inside it distinguishes them.
       * So the **known-sharing** line can never fire here — and it must not:
       * claiming "2 applications" would be inventing evidence. The amendment's
       * second signal covers this case by naming the *path* instead, which is
       * the only thing that is actually true.
       */
      const project = tempDir()
      const result = await run(["--app-id", "default", ...noDbArgs(home, project)], project)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Requests        1")
      expect(result.stdout).toContain("Cost (USD)      0.0030")
      expect(result.stdout).not.toContain("holds usage from")
      expect(result.stdout).toContain(`no --db was given, so this reads the default shared database ${db};`)
    })
  })

  it("A5 — localizes the notice and keeps the path and ids literal", async () => {
    const { dir, db, base } = sandbox()
    await threeApps(db)

    const result = await run(["usage", "summary", "--app-id", "cli-app", ...base], dir, { MIK_LANG: "zh" })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("说明：该库共有 3 个应用在记录用量（alpha-app, cli-app, temp-x）；用 --app <id> 只看其中一个。")
    expect(result.stdout).not.toContain("holds usage from")
    // The pre-existing Chinese lines are untouched.
    expect(result.stdout).toContain("请求数")
    expect(result.stdout).toContain("· app=cli-app")
  })

  it("A5 — the implicit-default notice is localized too, with the path literal", async () => {
    await withFakeHome(async (home, db) => {
      await seedApp(db, "default", [{ id: "d-1", usd: 0.003, input: 100 }])
      const project = tempDir()
      const result = await run([...noDbArgs(home, project)], project, { MIK_LANG: "zh" })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`说明：未指定 --db，本次读取的是默认共享库 ${db}；同机其它项目若也用默认设置，会写进同一个文件（要隔离请用 --db <自有库路径>）。`)
      expect(result.stdout).not.toContain("no --db was given")
      expect(result.stdout).not.toContain("该库共有")
    })
  })

  it("A1/API — appsInDatabase() lists what is on disk, once each and sorted", async () => {
    const { db } = sandbox()
    await seedApp(db, "zz-app", [{ id: "z-1", usd: 0.01, input: 10 }])
    await seedApp(db, "aa-app", [{ id: "a-1", usd: 0.01, input: 10 }])
    await seedApp(db, "aa-app", [{ id: "a-2", usd: 0.01, input: 10 }])

    const store = await Store.open({ path: db })
    // The instance's own appId ("cli-app") has **no** rows and is not returned:
    // this is a report about the file, not a list of who "I" am.
    const service = new UsageService({ store, appId: "cli-app", enabled: true })
    expect(service.appsInDatabase()).toEqual(["aa-app", "zz-app"])
    expect(store.usage.apps()).toEqual(["aa-app", "zz-app"])
    store.close()
  })

  it("A3 — `usage export` writes the pre-change header, column for column", async () => {
    const { dir, db, base } = sandbox()
    await threeApps(db)

    const result = await run(["usage", "export", "--format", "csv", ...base, "--app", "cli-app"], dir)
    expect(result.code).toBe(0)
    const header = normalize(result.stdout).split("\n")[0]
    expect(header).toBe(PRE_CHANGE_CSV_HEADER)
    // The frozen prefix, one name at a time: a rename or reorder fails by name.
    expect(header?.split(",").slice(0, 14)).toEqual(PRE_CHANGE_CSV_COLUMNS.slice(0, 14))
    expect(header?.split(",")).toEqual(PRE_CHANGE_CSV_COLUMNS)
    expect(header?.split(",")).toHaveLength(15)
    // GUARD: the exported constant still matches the literal above, so a change
    // to either side is caught (the two sides are independent).
    expect(USAGE_CSV_HEADER).toBe(PRE_CHANGE_CSV_HEADER)
    // And no notice leaks into a data format — neither signal.
    expect(result.stdout).not.toContain("holds usage from")
    expect(result.stdout).not.toContain("no --db was given")
  })

  it("① — the reported case: two projects, one default app_id, no --db", async () => {
    await withFakeHome(async (home, db) => {
      // Two unrelated projects. Neither passes `--db`, neither sets an app id,
      // so both write into the machine-wide default file under `default`.
      await seedApp(db, "default", [{ id: "project-a-1", usd: 0.004, input: 1000 }])
      await seedApp(db, "default", [{ id: "project-b-1", usd: 0.006, input: 1000 }])

      const project = tempDir()
      const result = await run(noDbArgs(home, project), project)
      expect(result.code).toBe(0)

      // 1. The merged total: two projects' rows in one number. This is the
      //    surprise the whole card is about, shown with a hand-computed figure.
      expect(result.stdout).toContain("Requests        2")
      expect(result.stdout).toContain("Cost (USD)      0.0100")

      // 2. The notice fires even though the file holds ONE app id, and it names
      //    the exact resolved file — not "the default" in the abstract.
      expect(result.stdout).toContain(
        `Note: no --db was given, so this reads the default shared database ${db}; ` +
          "another project using the same default settings writes into the same file " +
          "(pass --db <your own path> to keep usage separate).",
      )

      // 3. ...and it never claims KNOWN sharing: there is no evidence of it, and
      //    inventing a count here is exactly what the amendment forbids.
      expect(result.stdout).not.toContain("holds usage from")
    })
  })

  it("② — an explicit `--db` to that same file is completely silent", async () => {
    await withFakeHome(async (home, db) => {
      await seedApp(db, "default", [{ id: "project-a-1", usd: 0.004, input: 1000 }])
      await seedApp(db, "default", [{ id: "project-b-1", usd: 0.006, input: 1000 }])

      const result = await run(
        ["usage", "summary", "--offline", "--db", db, "--cache-dir", join(home, "cache"), "--config", join(tempDir(), "mik.config.json")],
        tempDir(),
      )
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Requests        2")
      // The caller named the file, so they already know what they are sharing.
      expect(result.stdout).not.toContain("no --db was given")
      expect(result.stdout).not.toContain("holds usage from")
      expect(result.stdout).not.toContain(db)
    })
  })

  it("③ — a single app on the implicit default: path and possibility, no invented count", async () => {
    await withFakeHome(async (home, db) => {
      await seedApp(db, "cli-app", [{ id: "only-1", usd: 0.002, input: 100 }])
      const project = tempDir()
      const result = await run(["--app-id", "cli-app", ...noDbArgs(home, project)], project)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Requests        1")
      // The exact path, which is only reachable through the new notice.
      expect(result.stdout).toContain(`no --db was given, so this reads the default shared database ${db};`)
      // No count and no name: one app id is not evidence of anything else.
      expect(result.stdout).not.toContain("applications")
    })
  })

  it("④ — both signals: two lines, distinct facts, the path named exactly once", async () => {
    await withFakeHome(async (home, db) => {
      await seedApp(db, "default", [{ id: "d-1", usd: 0.004, input: 100 }])
      await seedApp(db, "other-app", [{ id: "o-1", usd: 0.006, input: 100 }])

      const project = tempDir()
      const result = await run(noDbArgs(home, project), project)
      expect(result.code).toBe(0)
      const noteLines = normalize(result.stdout)
        .split("\n")
        .filter((line) => line.startsWith("Note:"))
      // EVO-G78 prepends its own scope notice as the first `Note:` line (a
      // different subject: the queried time window, not the file). It is
      // asserted here explicitly rather than filtered out silently, so it can
      // never be mistaken for one of the two database notices.
      expect(noteLines[0]).toBe(
        "Note: with no --from/--to this command covers the whole history; usage trends covers only the last 30 days by default.",
      )
      const lines = noteLines.slice(1)
      expect(lines).toEqual([
        `Note: no --db was given, so this reads the default shared database ${db}; ` +
          "another project using the same default settings writes into the same file " +
          "(pass --db <your own path> to keep usage separate).",
        "Note: this database holds usage from 2 applications (default, other-app); use --app <id> to see just one of them.",
      ])
      // No repetition: the file is named once, in the line that has to name it.
      expect(normalize(result.stdout).split(db)).toHaveLength(2)
      // The possibility line carries no evidence, the evidence line no path.
      expect(lines[0]).not.toContain("applications")
      expect(lines[1]).not.toContain(db)
    })
  })

  it("⑤ edge — an implicit default that does not exist yet is named too", async () => {
    await withFakeHome(async (home, db) => {
      // Nothing has ever written here: the file is created by this very run.
      // The risk B describes comes from the path being machine-wide, not from
      // what is in the file today, so the notice must not depend on row count.
      const project = tempDir()
      const result = await run(noDbArgs(home, project), project)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Requests        0")
      expect(result.stdout).toContain(`no --db was given, so this reads the default shared database ${db};`)
      expect(result.stdout).not.toContain("holds usage from")
    })
  })
})
