import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * EVO-G72b — `battery.ps1` must name its failures the way `battery.sh` does.
 *
 * The Windows battery used to read `if ("$s" -match "Requests") { … } else { Fail
 * "summary" }`: no `$LASTEXITCODE` check, and an empty message, so a red light on
 * the local gate arrived with no reason attached. `battery.sh` had already split
 * the two modes with `PIPESTATUS` (G72); these tests pin the same split on the
 * PowerShell side:
 *
 *   - the CLI exits non-zero  → "cli exit non-zero (exit code N)"
 *   - the CLI exits 0 but the asserted wording is absent → a per-step wording
 *
 * Both cases are driven through a real `battery.ps1` run with a **stub `node`**
 * on PATH, so the failing step under test really is the shipped path (the whole
 * point of A1 is that the diagnostic survives in the real script, not in a copy
 * of its logic).
 *
 * The stub is a pass-through for every other invocation, so the rest of the
 * battery still runs for real.
 *
 * Two properties of that stub are handled explicitly, because both bit during
 * review and neither is a property of the script under test:
 *
 *   - `.cmd` shim ⇒ `Start-Process -PassThru` records the cmd wrapper's pid, so
 *     the battery's own `finally` cannot reach the node grandchild. The test
 *     reaps those processes deterministically (`afterAll` → helper script) and
 *     fails loudly if any survive — a leak must never be silently tolerated.
 *   - the process kill is done by `reap-leaked-servers.ps1`, which keeps the
 *     port/path literals out of any shell command text (a runner that embeds the
 *     command it runs into its own CommandLine must not be matched by them).
 *
 * Platform: `battery.ps1` is the Windows/PowerShell half of the battery
 * (`Start-Process` + `$env:TEMP` + `curl.exe`), so the whole describe is skipped
 * — visibly, not silently — when there is no `pwsh` to run it with. A silent
 * `return` inside the bodies would report "passed" for two tests that never ran.
 */
const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const BATTERY_PS1 = join(ROOT, "scripts", "check-envs", "battery.ps1")
const REAPER = join(import.meta.dirname, "battery-diagnostics.helpers", "reap-leaked-servers.ps1")

/**
 * Set to another copy of `battery.ps1` (e.g. `git show HEAD:… > file`) to prove
 * these assertions are not tautological: the same run must go red against the
 * pre-fix script. Never changes the repo's file — the harness copies whatever it
 * is pointed at into the temp tree.
 */
const RUN_SOURCE = process.env.MIK_G72B_BATTERY_SOURCE ?? BATTERY_PS1

interface BatteryRun {
  database: string
  directory: string
  mockPort: number
  code: number | null
  output: string
}

const tempDirs: string[] = []
const runs: BatteryRun[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * Reap the stub's leaked services. Delegated to a helper process so this test's
 * own command text never carries the match literals; the helper still guards
 * every kill with a fresh CommandLine check. Both services need reaping — the
 * `serve` carries the db path, the `mock` carries neither db nor token, only its
 * port (the first cut matched the db only and silently leaked the mocks).
 */
function reap(run: BatteryRun): number {
  const out = execFileSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", REAPER, "-Config", String(process.pid), "-Token", run.database, "-Port", String(run.mockPort)],
    { encoding: "utf8" },
  )
  for (const line of out.split(/\r?\n/)) if (line.trim()) console.log(`[g72b] ${line.trim()}`)
  const m = /reap:\s+token=.*?\bkilled=(\d+)\s+remaining=(\d+)/.exec(out)
  expect(m, `reaper output shape: ${out}`).not.toBeNull()
  const remaining = Number(m?.[2] ?? "-1")
  expect(remaining, `leaked node services after reap (db ${run.database})`).toBe(0)
  return Number(m?.[1] ?? "0")
}

/**
 * The post-condition must not be self-certifying.
 *
 * `remaining` is computed with the *same* predicate the scan used, so a drifted
 * selector — one that matches nothing — reports `killed=0 remaining=0` and would
 * look clean while leaking both services (that was v1: a db-only predicate leaked
 * four mocks and still said `remaining=0`). The kill count is therefore asserted
 * separately: every run leaks exactly its serve + its mock, so a scan that found
 * nothing fails here, and the two numbers describe different things.
 */
const EXPECTED_KILLS_PER_RUN = 2

/** Frozen shape check for the leak detector, independent of the teardown. */
const STEP_FAIL_RE = /^\s*STEP\s+(.+?)\s+fail\s*$/gm
const EXPECTED_FAILING_STEP = "summary"

interface StepFail {
  line: string
  step: string
}

function stepFailures(text: string): StepFail[] {
  const found: StepFail[] = []
  for (const m of text.matchAll(STEP_FAIL_RE)) found.push({ line: m[0].trim(), step: m[1] as string })
  return found
}

afterAll(async () => {
  // Deterministic teardown: reap first (so the SQLite handles are released), then
  // remove the temp tree. Both steps must end clean; nothing is "given up on".
  for (const run of runs) {
    const killed = reap(run)
    // Independent of `remaining`: a scan that matched nothing is a broken selector,
    // not a clean machine. Both services leak, so a healthy run kills exactly two;
    // if this ever trips, read it as "the claim 'nothing leaked' is unproven".
    expect(killed, `expected 1 serve + 1 mock reaped for db ${run.database} (selector drifted?)`).toBe(EXPECTED_KILLS_PER_RUN)
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string
    let lastError: unknown
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        await new Promise((r) => setTimeout(r, 300))
      }
    }
    expect(lastError, `temp tree still on disk: ${dir}`).toBeUndefined()
  }
}, 120_000)

function hasPwsh(): boolean {
  const found = spawnSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true })
  return found.status === 0 && (found.stdout ?? "").trim().length > 0
}

const canRun = process.platform === "win32" && hasPwsh()

function writeStubNode(dir: string, body: string[]): void {
  // `%1` is the CLI script path, so the subcommand is `%2` — the exact shape the
  // battery uses (`node packages/mik/dist/cli.mjs usage summary`).
  const lines = [
    "@echo off",
    ...body,
    'if not defined REAL_NODE exit /b 97',
    '"%REAL_NODE%" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ]
  writeFileSync(join(dir, "node.cmd"), lines.join("\r\n"), "utf8")
}

/** One free port, released before the battery starts (it re-binds immediately). */
function freePort(): Promise<number> {
  return new Promise((done) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => done(port))
    })
  })
}

async function runBattery(stub: string[], database: string): Promise<BatteryRun> {
  const dir = tempDir("mik-g72b-")
  const scripts = join(dir, "scripts")
  // The stub lives in its own directory: prepending it to PATH must not shadow
  // anything the battery needs besides `node` itself.
  const stubDir = join(dir, "stubbin")
  mkdirSync(scripts, { recursive: true })
  mkdirSync(stubDir, { recursive: true })
  copyFileSync(RUN_SOURCE, join(scripts, "battery.ps1"))
  writeStubNode(stubDir, stub)

  const serve = await freePort()
  const mock = await freePort()
  const env = { ...process.env, PATH: `${stubDir};${process.env.PATH ?? ""}`, REAL_NODE: process.execPath }

  const output = await new Promise<{ text: string; code: number | null }>((done) => {
    const child = spawn(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scripts, "battery.ps1"), "powershell", ROOT, String(serve), String(mock), database],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    )
    let text = ""
    child.stdout.on("data", (c) => (text += c))
    child.stderr.on("data", (c) => (text += c))
    child.on("close", (code) => done({ text, code }))
  })
  const run: BatteryRun = { database, directory: dir, mockPort: mock, code: output.code, output: output.text }
  runs.push(run)
  return run
}

/** `node <script> usage summary` → exit 3: the CLI itself failed. */
const STUB_CLI_NONZERO = [
  'if "%2"=="usage" if "%3"=="summary" (',
  "  echo note: simulated CLI non-zero exit 1>&2",
  "  exit /b 3",
  ")",
]

/** `node <script> usage summary` → exit 0 with no matching wording. */
const STUB_OUTPUT_EMPTY = [
  'if "%2"=="usage" if "%3"=="summary" (',
  "  echo note: usage summary printed no matching line 1>&2",
  "  exit /b 0",
  ")",
]

function lines(text: string): string[] {
  return text.split(/\r?\n/)
}

describe.skipIf(!canRun)("EVO-G72b: battery.ps1 names its failure modes (A1)", () => {
  /** Both runs drive the same script; each captures one failure mode end to end. */
  let cliNonZero: BatteryRun | undefined
  let outputEmpty: BatteryRun | undefined

  beforeAll(async () => {
    const dir = tempDir("mik-g72b-db-")
    cliNonZero = await runBattery(STUB_CLI_NONZERO, join(dir, "nonzero.db"))
    outputEmpty = await runBattery(STUB_OUTPUT_EMPTY, join(dir, "empty.db"))
  }, 180_000)

  function need(run: BatteryRun | undefined, which: string): BatteryRun {
    if (!run) throw new Error(`battery run missing: ${which} (beforeAll did not complete)`)
    return run
  }

  it("reports the CLI's own exit code when the command exits non-zero (A1①, A1②)", () => {
    const run = need(cliNonZero, "cliNonZero")
    const text = lines(run.output)
    // The failing step must be reached — otherwise this test would pass on a
    // battery that never got far enough to exercise the diagnostic at all.
    expect(run.output).toContain("STEP summary fail")
    expect(run.code).not.toBe(0)
    expect(text.some((l) => /^FAIL\[powershell\] summary cli exit non-zero \(exit code 3\)\s*$/.test(l))).toBe(true)
    // The two modes must not share a wording.
    expect(run.output).not.toContain("no Requests line")
  }, 180_000)

  it("reports the missing expected content when the CLI exits 0 (A1②)", () => {
    const run = need(outputEmpty, "outputEmpty")
    const text = lines(run.output)
    expect(run.output).toContain("STEP summary fail")
    expect(run.code).not.toBe(0)
    expect(text.some((l) => /^FAIL\[powershell\] summary no Requests line\s*$/.test(l))).toBe(true)
    expect(run.output).not.toContain("cli exit non-zero")
  }, 180_000)

  it("exposes a reaper key per run (unique db path + mock port)", () => {
    // The two selectors `afterAll` passes to the reaper must actually exist on the
    // run, or the teardown would quietly have nothing to match. A silently empty
    // reap is exactly the failure this guard makes visible.
    const first = need(cliNonZero, "cliNonZero")
    const second = need(outputEmpty, "outputEmpty")
    for (const run of [first, second]) {
      expect(run.database).toContain("mik-g72b-db-")
      expect(run.mockPort).toBeGreaterThan(0)
    }
    expect(first.database).not.toBe(second.database)
  }, 30_000)

  it("fails on exactly the summary step and on nothing else", () => {
    // R1: the other `CliFailed` sites (bin-direct / provider-add / csv / python) are
    // only ever exercised on their success path by these runs, so a stray failure
    // anywhere else means a new `$LASTEXITCODE` guard misfired on a healthy machine.
    // Naming the *only* tolerated failure keeps that visible.
    //
    // Exactly one entry, because `Fail` exits the battery at the first failure — so
    // a second entry would mean the run kept going after a failure. The step names
    // are fixed, so this is not tautological: it fails if the regex misses the
    // marker line, if another step turns red, or if the run continues past a failure.
    expect(stepFailures(need(cliNonZero, "cliNonZero").output)).toEqual([{ line: "STEP summary fail", step: EXPECTED_FAILING_STEP }])
    expect(stepFailures(need(outputEmpty, "outputEmpty").output)).toEqual([{ line: "STEP summary fail", step: EXPECTED_FAILING_STEP }])
  }, 30_000)

  it("would notice a second failing step (self-check for the guard above)", () => {
    const control = "STEP health fail\nSTEP summary fail\nFAIL[powershell] health "
    expect(stepFailures(control)).toEqual([
      { line: "STEP health fail", step: "health" },
      { line: "STEP summary fail", step: "summary" },
    ])
  }, 30_000)
})
