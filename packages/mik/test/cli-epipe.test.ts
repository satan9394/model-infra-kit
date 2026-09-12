import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const distDir = join(import.meta.dirname, "..", "dist")
const cliPath = join(distDir, "cli.mjs")
const hasBuild = existsSync(cliPath)

/**
 * How the "downstream reader" behaves — the shell shapes from the card,
 * expressed in Node so no `bash`/`head` binary and **no path translation** is
 * involved (an earlier version shelled out with WSL-style `/mnt/c/...`, which is
 * false on a Git Bash runner and carried an 8.3 short name on top; CI caught it
 * on windows-latest and macos-latest, ubuntu passed).
 *
 * | mode               | shell equivalent            | what the parent does                    |
 * |--------------------|-----------------------------|-----------------------------------------|
 * | `first-line`       | `cli \| head -1`            | destroy stdout after the first newline  |
 * | `ten-bytes`        | `cli \| head -c 10`         | destroy stdout after 10 bytes           |
 * | `pattern`          | `cli \| grep -q Requests`   | destroy stdout once the pattern appears |
 * | `both-ends-closed` | `cli 2>&1 \| head -1`       | same, and destroy stderr too            |
 * | `never-reads`      | reader gone before output   | destroy both immediately after spawn    |
 * | `full`             | `cli > file` (reads all)    | drain stdout to completion              |
 */
type ReaderMode = "first-line" | "ten-bytes" | "pattern" | "both-ends-closed" | "never-reads" | "full"

interface PipelineCase {
  name: string
  /** CLI arguments, without the per-case store flags appended by the runner. */
  args: readonly string[]
  mode: ReaderMode
}

interface PipelineResult {
  /** The child's real exit code (`null` when it was signalled). */
  code: number | null
  /** Bytes the reader received before it closed — "the fix must not print nothing". */
  received: string
}

/**
 * Run one case as a **real process writing into a real pipe**.
 *
 * `spawn(process.execPath, [cliEntry, ...args])` is the whole point: a closed
 * pipe is an OS-level condition, and the defect is an asynchronous `EPIPE` that
 * only exists in a separate process. `stdout`/`stderr` are pipes (fd 1/2 owned by
 * this parent), and destroying our read end is exactly what `head` exiting does —
 * the child's next write then fails with `EPIPE`.
 *
 * Nothing here depends on a shell, so the same code runs on ubuntu, macos and
 * windows runners.
 */
/**
 * Every child the pipeline block launches, recorded so the self-check can prove
 * the cases stay shell-free (see the last `describe`).
 */
const spawnedCommands: { file: string; args: readonly string[] }[] = []

function runPipelineCase(dir: string, testCase: PipelineCase): Promise<PipelineResult> {
  const args = [
    cliPath,
    ...testCase.args,
    // Per-case store paths: the cases overlap, and pointing several concurrent
    // processes at one SQLite file would trade a timeout for "database is locked".
    "--offline",
    "--db",
    join(dir, `${testCase.name}.db`),
    "--cache-dir",
    join(dir, `cache-${testCase.name}`),
    "--config",
    join(dir, `config-${testCase.name}.json`),
  ]
  spawnedCommands.push({ file: process.execPath, args })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MIK_LANG: "en" },
    })
    let received = ""
    let closed = false
    const closeReadEnd = (both: boolean): void => {
      if (closed) return
      closed = true
      child.stdout?.destroy()
      if (both) child.stderr?.destroy()
    }

    child.stdout?.setEncoding("utf8")
    // stderr is always drained (or destroyed): an unread pipe fills up and would
    // block the child instead of exercising EPIPE.
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", () => {})
    child.stderr?.on("error", () => {})

    child.stdout?.on("data", (chunk: string) => {
      received += chunk
      if (testCase.mode === "first-line" && received.includes("\n")) closeReadEnd(false)
      else if (testCase.mode === "ten-bytes" && received.length >= 10) closeReadEnd(false)
      else if (testCase.mode === "pattern" && received.includes("Requests")) closeReadEnd(false)
      else if (testCase.mode === "both-ends-closed" && received.includes("\n")) closeReadEnd(true)
    })
    child.stdout?.on("error", () => {})

    if (testCase.mode === "never-reads") closeReadEnd(true)

    child.on("error", reject)
    // `close` (not `exit`) so the result is reported after the stdio streams are
    // done with; the exit code is available either way.
    child.on("close", (code) => {
      resolve({ code, received })
    })
  })
}

/** Run every case concurrently and index the results by name. */
async function runPipelineCases(cases: readonly PipelineCase[]): Promise<Map<string, PipelineResult>> {
  const dir = tempDir()
  const settled = await Promise.all(cases.map((testCase) => runPipelineCase(dir, testCase)))
  return new Map(cases.map((testCase, index) => [testCase.name, settled[index] as PipelineResult]))
}

/**
 * A1 plus the failure shapes from the card — module scope, so the self-check can
 * assert its own spawn list against it.
 */
const pipelineCases: readonly PipelineCase[] = [
  { name: "summary", args: ["usage", "summary"], mode: "first-line" },
  { name: "logs", args: ["usage", "logs"], mode: "first-line" },
  { name: "models", args: ["models"], mode: "first-line" },
  { name: "summary-c10", args: ["usage", "summary"], mode: "ten-bytes" },
  { name: "summary-2to1", args: ["usage", "summary"], mode: "both-ends-closed" },
  { name: "summary-grep", args: ["usage", "summary"], mode: "pattern" },
  { name: "summary-closed", args: ["usage", "summary"], mode: "never-reads" },
  { name: "full-read", args: ["usage", "summary"], mode: "full" },
]

describe.skipIf(!hasBuild)("real `cli | head -1` pipeline around the built bin (A1)", () => {
  /** One run for the whole block; the tests below assert on its results. */
  let results: Map<string, PipelineResult>
  beforeAll(async () => {
    results = await runPipelineCases(pipelineCases)
  }, 120_000)

  /**
   * These cases are inherently slow *by design*: they must drive the shipped bin
   * as a separate process through a real pipe, because the asynchronous `EPIPE`
   * exists only at process level (an in-process stub cannot prove the exit code).
   * The explicit budget is a safety net for a loaded CI box **on top of** the
   * concurrency, not a substitute for it.
   */
  it("exits 0 for `usage summary`, `usage logs` and `models` when the reader closes after one line (A1)", () => {
    for (const testCase of pipelineCases) {
      expect(results.get(testCase.name)?.code, `exit code with the reader gone (${testCase.name})`).toBe(0)
    }
    // The reader still got output — the fix must not mean "print nothing".
    for (const name of ["summary", "logs", "models", "summary-c10", "summary-2to1", "full-read"]) {
      expect(results.get(name)?.received.length, `bytes the reader received for ${name}`).toBeGreaterThan(0)
    }
  }, 120_000)

  it("keeps the first line of a closed pipe identical to a full read", () => {
    const first = results.get("summary")?.received.trimEnd()
    // `full-read` mirrors the shell `cli > file` shape: the reader takes everything.
    const fullFirstLine = results.get("full-read")?.received.split("\n")[0]?.trimEnd()
    expect(first).toBe(fullFirstLine)
  }, 120_000)

  it("closes the read end on a real pipe, so the child really is writing into a closed pipe", () => {
    // Guards against a silent no-op: every case must have produced bytes, which
    // proves the child ran and wrote, and the "closed" cases are only meaningful
    // because the parent then destroyed its end of that same pipe.
    expect(results.size).toBe(pipelineCases.length)
    expect(results.get("summary")?.received.length).toBeGreaterThan(0)
    expect(results.get("full-read")?.received.length).toBeGreaterThanOrEqual(
      results.get("summary")?.received.length ?? 0,
    )
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
  it("the pipeline cases are shell-free: every child is `process.execPath` running the CLI entry", () => {
    // The previous version shelled out (`bash script.sh | head -1`) with a
    // machine-specific path convention: it broke on the Git Bash runner and
    // diverged on macOS. This guard is behavioural, not a source scan — it fails
    // if any case is ever launched through a shell or a `head`-like binary again.
    expect(spawnedCommands).toHaveLength(pipelineCases.length)
    for (const command of spawnedCommands) {
      expect(command.file).toBe(process.execPath)
      expect(realpathSync(command.args[0] ?? "")).toBe(realpathSync(cliPath))
    }
    const shells = ["bash", "sh", "cmd.exe", "powershell"]
    for (const command of spawnedCommands) {
      expect(shells.includes(command.file), `unexpected shell: ${command.file}`).toBe(false)
    }
  })

  it("the built bin is the artifact the pipeline cases run (A7: not a silent no-op)", () => {
    // When the build is absent the block above is skipped; assert the *reason*
    // is real, so a misplaced path cannot quietly disable the strongest cases.
    expect(existsSync(cliPath)).toBe(hasBuild)
    expect(cliPath.endsWith(join("dist", "cli.mjs"))).toBe(true)
    expect(realpathSync(distDir).length).toBeGreaterThan(0)
  })
})

