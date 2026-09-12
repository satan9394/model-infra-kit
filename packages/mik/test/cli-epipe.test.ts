import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { main } from "../src/cli/index.js"
import { installStreamGuard, isEpipeError, resetStreamGuard, writeGuarded } from "../src/util/pipe.js"
import type { StreamGuardState } from "../src/util/pipe.js"

/**
 * EVO-G76 — a downstream reader that closes early must not fail the command.
 *
 * The defect lives in `process.stdout.write`: node reports a closed pipe
 * **asynchronously** as an `error` event, so `mik usage summary | head -1` still
 * returns 0 from `main()` and then dies with an uncaught `EPIPE` and exit code
 * 1. `--help` survived only because its whole output fits in one write.
 *
 * Three layers of evidence, on purpose:
 *
 * - the shared chokepoint (`src/cli/context.ts` writes every command through
 *   `writeGuarded`), with injected streams — deterministic, no shell;
 * - a real `cli | head -1` pipeline around the **built bin**, the only way to
 *   observe the process exit code;
 * - short child processes that turn the guard's decision into a real
 *   `process.exitCode`, which is what makes the reverse case (A2) bite.
 *
 * A1 (3+ multi-line commands exit 0) is the pipeline block; A2 (non-EPIPE still
 * fails) is its reverse and fails if the guard ever swallows broadly.
 */

const tempDirs: string[] = []
const realStdout = process.stdout

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g76-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

/** Flags that keep every run offline and off the real `~/.model-infra-kit`. */
function sandbox(): string[] {
  const dir = tempDir()
  return ["--offline", "--db", join(dir, "usage.db"), "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")]
}

function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32 })
}

function enospc(): NodeJS.ErrnoException {
  return Object.assign(new Error("write ENOSPC: no space left on device"), { code: "ENOSPC", errno: -28 })
}

/**
 * A stdout stand-in that fails the way a closed pipe does.
 *
 * It is a real `Writable`, so both the guard's write path and the stream's own
 * `emit("error", ...)` are exercised, and it emits the failure
 * **asynchronously** on the first write — exactly what node does for `EPIPE`.
 * It carries its own `error` listener because the only listener the guard ever
 * installs lives on the stream that was `process.stdout` at install time.
 */
class FailingWritable extends Writable {
  readonly chunks: string[] = []
  private readonly failure: NodeJS.ErrnoException
  private fired = false

  constructor(failure: NodeJS.ErrnoException) {
    super()
    this.failure = failure
    this.on("error", () => {})
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk))
    if (!this.fired) {
      this.fired = true
      queueMicrotask(() => this.emit("error", this.failure))
    }
    callback()
  }
}

/**
 * Install a fresh guard **on the injected stream** and return its bookkeeping.
 *
 * The order matters and mirrors the bin: `resetStreamGuard()` forgets the
 * previous listeners (vitest runs the whole file in one process), the shim makes
 * the injected stream `process.stdout`, and only then does `installStreamGuard`
 * attach the `error` listener — the bin calls it before its first write, which
 * is why a closed pipe cannot slip past it.
 */
function installGuardedStdout(stream: Writable | NodeJS.WritableStream): StreamGuardState {
  resetStreamGuard()
  vi.spyOn(process, "stdout", "get").mockReturnValue(stream as unknown as typeof process.stdout)
  return installStreamGuard()
}

/** Let the queued `error` event and the guard's reaction run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

afterEach(() => {
  // vitest's own reporter writes to stdout; restoring it here keeps its output
  // intact even if an assertion fails mid-test.
  vi.restoreAllMocks()
  expect(process.stdout).toBe(realStdout)
})

describe("EPIPE tolerance at the single CLI output chokepoint", () => {
  it("records a closed reader as 'broken pipe' and does not report it as an error (A1, A7)", async () => {
    const stream = new FailingWritable(epipe())
    const state = installGuardedStdout(stream)
    const err: string[] = []

    const code = await main(["usage", "summary", ...sandbox()], {
      env: { ...process.env, MIK_LANG: "en" },
      interactive: false,
      io: { err: (text) => err.push(text) },
    })
    await settle()

    expect(stream.chunks.length).toBeGreaterThan(0)
    expect(state.stdoutBroken).toBe(true)
    expect(code).toBe(0)
    // `report()` must not have turned a closed reader into "mik failed".
    expect(err.join("")).not.toContain("EPIPE")
  })

  it("drops later writes instead of queueing bytes for a reader that is gone", async () => {
    const stream = new FailingWritable(epipe())
    const state = installGuardedStdout(stream)

    await main(["usage", "summary", ...sandbox()], { env: { ...process.env, MIK_LANG: "en" }, interactive: false })
    await settle()
    const afterBreak = stream.chunks.length
    expect(afterBreak).toBeGreaterThan(0)
    expect(state.stdoutBroken).toBe(true)

    // A second invocation in the same process sees the broken pipe immediately.
    const code = await main(["usage", "logs", ...sandbox()], { env: { ...process.env, MIK_LANG: "en" }, interactive: false })
    expect(code).toBe(0)
    expect(stream.chunks.length).toBe(afterBreak)
  })

  it("keeps a non-EPIPE stream failure visible instead of swallowing it (A2 reverse)", async () => {
    const stream = new FailingWritable(enospc())
    const state = installGuardedStdout(stream)
    // A *listener*, not a spy on `process.emit`: replacing `emit` breaks the
    // worker's own event machinery and hangs vitest's RPC channel (that produced
    // "[vitest-worker]: Timeout calling onTaskUpdate" plus a 60s hang). Capturing
    // the re-emitted error is enough — the child processes below prove the crash.
    const surfaced: unknown[] = []
    const onProcessError = (error: unknown): void => {
      surfaced.push(error)
    }
    process.on("error", onProcessError)
    try {
      await main(["usage", "summary", ...sandbox()], {
        env: { ...process.env, MIK_LANG: "en" },
        interactive: false,
        io: { err: () => {} },
      })
      await settle()

      // Not a closed reader: the guard hands the failure to `process`.
      expect(surfaced).toHaveLength(1)
      expect((surfaced[0] as NodeJS.ErrnoException | undefined)?.code).toBe("ENOSPC")
      expect(state.stdoutBroken).toBe(false)
    } finally {
      process.off("error", onProcessError)
    }
  })

  it("reports a synchronous non-EPIPE write failure with exit code 1 (A2 reverse)", async () => {
    const stream = new Writable({ write: () => {} })
    // A synchronous throw is not what node streams do for a closed pipe, but a
    // patched/foreign writable can: `writeGuarded` must route it to `report`
    // rather than mark the pipe broken.
    stream.write = () => {
      throw enospc()
    }
    const state = installGuardedStdout(stream)
    const err: string[] = []

    const code = await main(["usage", "summary", ...sandbox()], {
      env: { ...process.env, MIK_LANG: "en" },
      interactive: false,
      io: { err: (text) => err.push(text) },
    })

    expect(code).toBe(1)
    expect(err.join("")).toContain("ENOSPC")
    // A real failure is never recorded as "nobody is reading".
    expect(state.stdoutBroken).toBe(false)
  })

  it("classifies EPIPE by code or errno only, so nothing wider is tolerated", () => {
    // Both layers share this predicate; if it ever widened, the reverse cases
    // above would stop failing.
    expect(isEpipeError(Object.assign(new Error("broken pipe"), { errno: -32 }))).toBe(true)
    expect(isEpipeError(Object.assign(new Error("x"), { code: "EPIPE" }))).toBe(true)
    expect(isEpipeError(enospc())).toBe(false)
    expect(isEpipeError(new Error("plain"))).toBe(false)
    expect(isEpipeError(undefined)).toBe(false)
  })

  it("stops writing after EPIPE on one pipe, so a closed stderr cannot crash later (stderr case)", () => {
    const state: StreamGuardState = { stdoutBroken: false, stderrBroken: false }
    const attempts: string[] = []
    const sink = {
      write(text: string): boolean {
        attempts.push(text)
        throw epipe()
      },
    }
    writeGuarded(sink as unknown as Writable, "first\n", { state })
    // Under `2>&1 | head -1` stdout and stderr are the same pipe: both stop.
    expect(state.stdoutBroken).toBe(true)
    expect(state.stderrBroken).toBe(true)
    writeGuarded(sink as unknown as Writable, "second\n", { state })
    expect(attempts).toEqual(["first\n"])
  })
})

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}`)
}

/**
 * The long-form POSIX path of a Windows path.
 *
 * `mkdtempSync(tmpdir(), ...)` returns the 8.3 form (`C:\Users\SATANC~1\...`)
 * on this host, which WSL cannot resolve, so the existing directory is resolved
 * and a not-yet-created file is appended by name.
 */
function posixPath(path: string): string {
  return toPosixPath(join(dirname(path), basename(path)))
}

const distDir = join(import.meta.dirname, "..", "dist")
const cliPath = join(distDir, "cli.mjs")
const hasBuild = existsSync(cliPath)
const shellAvailable = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok"

/**
 * Every pipeline case runs inside **one** POSIX-shell invocation, and the cases
 * run **concurrently** inside it (`&` + `wait`).
 *
 * Why, precisely: each case is a real `node dist/cli.mjs` cold start. Under WSL
 * that costs ~2.5–4 s per process, so six sequential spawns took ~20 s and the
 * 30 s `testTimeout` was being blown whenever the other 26 files saturated the
 * machine (observed: `Test timed out in 30000ms` in a full run while the file
 * passed alone — R99's "green only on my machine" in a new shape). Running them
 * in parallel collapses the wall time to roughly one cold start, and a single
 * shell launch removes five redundant `bash` starts.
 *
 * `pipefail` is what makes the producer's exit code observable: a plain `a | b`
 * reports `b`'s status, which is 0 no matter how `mik` died. Each subshell
 * captures `$?` of its own pipeline right after it, into its own `.res` file.
 */
interface PipelineCase {
  name: string
  /** The producer, with its output fed to `reader`. */
  command: (argv: string[]) => string
  reader: string
}

function runPipelineCases(cases: readonly PipelineCase[]): { codes: Map<string, number>; bytes: Map<string, number>; dir: string } {
  const dir = tempDir()
  const scriptFile = join(dir, "epipe-cases.sh")
  const lines = ["set -u", "set -o pipefail", `cd "${posixPath(dir)}"`]
  for (const testCase of cases) {
    // Per-case store paths: the cases now overlap, and pointing seven concurrent
    // processes at one SQLite file would trade a timeout for "database is locked".
    const argv = [
      "--offline",
      "--db",
      join(dir, `${testCase.name}.db`),
      "--cache-dir",
      join(dir, `cache-${testCase.name}`),
      "--config",
      join(dir, `config-${testCase.name}.json`),
    ]
    const errFile = join(dir, `${testCase.name}.err`)
    const outFile = join(dir, `${testCase.name}.out`)
    const resFile = join(dir, `${testCase.name}.res`)
    const pipeline = `node "${posixPath(cliPath)}" ${testCase.command(argv)} 2>"${posixPath(errFile)}" | ${testCase.reader} > "${posixPath(outFile)}"`
    // Subshell + `&`: the cases are independent, so they overlap. The result must
    // be written to a file, because `echo` from a background job would otherwise
    // interleave with its siblings on the shared stdout.
    lines.push(
      `( ${pipeline}; echo "CASE ${testCase.name} rc=$? bytes=$(wc -c < "${posixPath(outFile)}")" > "${posixPath(resFile)}" ) &`,
    )
  }
  lines.push("wait")
  for (const testCase of cases) lines.push(`cat "${posixPath(join(dir, `${testCase.name}.res`))}"`)
  writeFileSync(scriptFile, `${lines.join("\n")}\n`, "utf8")
  const stdout = execFileSync("bash", [posixPath(scriptFile)], { encoding: "utf8", env: { ...process.env, MIK_LANG: "en" } })
  const codes = new Map<string, number>()
  const bytes = new Map<string, number>()
  for (const match of stdout.matchAll(/^CASE (\S+) rc=(\d+) bytes=(\d+)$/gm)) {
    const [, name, rc, received] = match
    if (!name || rc === undefined || received === undefined) continue
    codes.set(name, Number(rc))
    bytes.set(name, Number(received))
  }
  return { codes, bytes, dir }
}

describe.skipIf(!hasBuild || !shellAvailable)("real `cli | head -1` pipeline around the built bin (A1)", () => {
  const quote = (argv: readonly string[]): string => argv.map((arg) => `"${arg}"`).join(" ")

  /**
   * A1 plus the failure shapes from the card, in one shell run:
   * reader closes after the first line, mid-write, with stdout and stderr
   * sharing the pipe, the `grep -q` shape the battery uses, and a full read
   * (the `cat` case) that the prefix assertion compares against.
   */
  const cases: readonly PipelineCase[] = [
    { name: "summary", command: (argv) => `usage summary ${quote(argv)}`, reader: "head -1" },
    { name: "logs", command: (argv) => `usage logs ${quote(argv)}`, reader: "head -1" },
    { name: "models", command: (argv) => `models ${quote(argv)}`, reader: "head -1" },
    { name: "summary-c10", command: (argv) => `usage summary ${quote(argv)}`, reader: "head -c 10" },
    { name: "summary-2to1", command: (argv) => `usage summary ${quote(argv)} 2>&1`, reader: "head -1" },
    { name: "summary-grep", command: (argv) => `usage summary ${quote(argv)}`, reader: 'grep -q "Requests"' },
    { name: "full-read", command: (argv) => `usage summary ${quote(argv)}`, reader: "cat" },
  ]

  /** One shell launch for the whole block; both tests assert on its results. */
  let results: { codes: Map<string, number>; bytes: Map<string, number>; dir: string }
  beforeAll(() => {
    results = runPipelineCases(cases)
  }, 120_000)

  /**
   * These two cases are inherently slow *by design*: they must drive the shipped
   * bin through a real pipe, because the async `EPIPE` only exists at process
   * level (an in-process stub cannot prove the exit code). The explicit budget is
   * a safety net for a loaded CI box **on top of** the concurrency above, not a
   * substitute for it.
   */
  it("exits 0 for `usage summary`, `usage logs` and `models` when the reader closes after one line (A1)", () => {
    for (const testCase of cases) {
      expect(results.codes.get(testCase.name), `pipeline exit code for ${testCase.name}`).toBe(0)
    }
    // The reader still got output — the fix must not mean "print nothing".
    for (const name of ["summary", "logs", "models", "summary-c10", "summary-2to1", "full-read"]) {
      expect(results.bytes.get(name), `bytes the reader received for ${name}`).toBeGreaterThan(0)
      expect(existsSync(join(results.dir, `${name}.out`))).toBe(true)
    }
  }, 120_000)

  it("keeps `head -1` a prefix of the full output, not a truncation", () => {
    const first = readFileSync(join(results.dir, "summary.out"), "utf8").trimEnd()
    const full = readFileSync(join(results.dir, "full-read.out"), "utf8").split("\n")[0]?.trimEnd()
    expect(first).toBe(full)
  }, 120_000)
})

/**
 * One child process per mode, asserting a **real** `process.exitCode`.
 *
 * - `epipe`: a closed reader must end the process with 0 (the defect was 1).
 * - `syncError`: a non-EPIPE throw reaches `report`, which exits 1 — inside
 *   `main` this is a returned code, and via top-level `await` it is node's
 *   unhandled-rejection path. Either way it must not be 0.
 * - `eventError`: a non-EPIPE stream error stays an uncaught exception, so a
 *   full disk is never silently swallowed by this fix.
 */
function childScript(mode: string, errorCode: string, errno: number): string {
  return [
    `const cli = await import(${JSON.stringify(pathToFileURL(realpathSync(cliPath)).href)})`,
    "const { EventEmitter } = await import('node:events')",
    `const MODE = ${JSON.stringify(mode)}`,
    `const FAILURE = Object.assign(new Error('write ' + ${JSON.stringify(errorCode)}), { code: ${JSON.stringify(errorCode)}, errno: ${errno} })`,
    "let writes = 0",
    "class Sink extends EventEmitter {",
    "  write(text) {",
    "    if (text) {",
    "      writes += 1",
    "      if (writes === 1) {",
    "        if (MODE === 'eventError') queueMicrotask(() => this.emit('error', FAILURE))",
    "        else throw FAILURE",
    "      }",
    "    }",
    "    return true",
    "  }",
    "}",
    // A real EventEmitter, so the listener `main()` installs for itself is
    // genuinely registered on this stream and its re-emit decision is what gets
    // observed. Deliberately *not* a direct `installStreamGuard` call: the guard
    // is a CLI implementation detail with no public export (`mik/cli` exposes
    // `main`, and `main` owns the install), so the child exercises the real path.
    "Object.defineProperty(process, 'stdout', { value: new Sink(), configurable: true })",
    "process.exitCode = await cli.main(['--help'], { env: { ...process.env, MIK_LANG: 'en' }, interactive: false })",
    "",
  ].join("\n")
}

function runChild(mode: string, errorCode: string, errno: number): { status: number | null; stderr: string } {
  const dir = tempDir()
  const file = join(dir, "child.mjs")
  writeFileSync(file, childScript(mode, errorCode, errno), "utf8")
  try {
    execFileSync(process.execPath, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return { status: 0, stderr: "" }
  } catch (error) {
    return {
      status: (error as { status?: number | null }).status ?? null,
      stderr: String((error as { stderr?: string }).stderr ?? ""),
    }
  }
}

describe.skipIf(!hasBuild)("process-level exit codes for the guard's own paths (A1/A2)", () => {
  it("exits 0 for a closed reader (EPIPE)", () => {
    const result = runChild("epipe", "EPIPE", -32)
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("EPIPE")
  })

  it("exits 1 for a synchronous non-EPIPE failure", () => {
    const result = runChild("syncError", "ENOSPC", -28)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("ENOSPC")
  })

  it("exits non-zero for a non-EPIPE stream error (nothing real is swallowed)", () => {
    const result = runChild("eventError", "ENOSPC", -28)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("ENOSPC")
  })
})

describe("spawn-level self-check", () => {
  it("bash is available for the process-level cases (guards against a silent skip)", () => {
    // A silent skip would turn the strongest evidence into a no-op; this fails
    // loudly instead if the shell is missing.
    expect(shellAvailable).toBe(true)
  })

  it("the built bin is the artifact the pipeline cases run (A7: not a silent no-op)", () => {
    // When the build is absent the block above is skipped; assert the *reason*
    // is real, so a misplaced path cannot quietly disable the strongest cases.
    expect(existsSync(cliPath)).toBe(hasBuild)
    expect(cliPath.endsWith(join("dist", "cli.mjs"))).toBe(true)
    expect(realpathSync(distDir).length).toBeGreaterThan(0)
  })
})
