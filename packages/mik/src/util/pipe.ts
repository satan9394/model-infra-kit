/**
 * EVO-G76 — a downstream reader that closes early (`mik usage summary | head -1`)
 * must not turn a successful command into a crash.
 *
 * `process.stdout.write` reports a closed pipe **asynchronously**: the first
 * write after the reader is gone still returns normally, and node emits an
 * `error` event on the stream afterwards. With no `error` listener that event is
 * re-thrown as an uncaught exception (`EPIPE`, errno -32) and the process dies
 * with exit code 1, even though the command itself succeeded.
 *
 * This module owns the single place where that is handled. Two layers, on
 * purpose:
 *
 * 1. {@link installStreamGuard} attaches the `error` listener to the real
 *    `stdout`/`stderr` once per process. Only `EPIPE` is tolerated; after a
 *    broken pipe the pipe is marked, so a long command can stop writing instead
 *    of firing one error event per line.
 * 2. {@link writeGuarded} is what the default CLI `io` writes through, so a
 *    synchronous throw (rare, but possible on some platforms) obeys the same
 *    rule, and the marked-broken check happens before queueing more bytes.
 *
 * Anything that is **not** `EPIPE` is propagated to the caller's `onError` (the
 * CLI re-emits it on `process`, keeping node's "uncaught exception → exit code
 * 1" path intact). A full disk or a broken stream must still be visible and must
 * still fail the process — swallowing every write error is explicitly not the
 * fix (EVO-G76 acceptance A2).
 */
import type { Writable } from "node:stream"

/** `EPIPE`: the reader closed its end of the pipe. `-32` is its POSIX errno. */
export function isEpipeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as NodeJS.ErrnoException
  return candidate.code === "EPIPE" || candidate.errno === -32
}

/** Which pipes a reader has already closed. */
export interface StreamGuardState {
  stdoutBroken: boolean
  stderrBroken: boolean
}

/** Per-process state, so the CLI's default `io` and the listeners agree. */
const defaultState: StreamGuardState = { stdoutBroken: false, stderrBroken: false }
let installed = false

/**
 * The rule both layers share: `EPIPE` marks the pipe (both ends — under `2>&1`
 * stdout and stderr are the same pipe), anything else goes to `onError`.
 */
export function handleStreamError(
  error: unknown,
  state: StreamGuardState,
  onError: (error: unknown) => void,
): void {
  if (isEpipeError(error)) {
    state.stdoutBroken = true
    state.stderrBroken = true
    return
  }
  onError(error)
}

/**
 * Attach the EPIPE tolerance to the real process streams. Called once, from
 * `main()` before anything is written; repeated calls are no-ops so the listener
 * and the broken-pipe state cannot be duplicated (tests install their own guard
 * on injected streams via {@link writeGuarded}).
 */
export function installStreamGuard(): StreamGuardState {
  if (installed) return defaultState
  installed = true
  const onError = (error: unknown): void =>
    handleStreamError(error, defaultState, (unexpected) => {
      // Not a closed reader (a full disk, a detached pty, ...): keep node's
      // default crash path, so a real write failure still exits non-zero. There
      // is no caller to throw at from an event listener.
      queueMicrotask(() => {
        // `process.emit` is typed for signal names only; "error" is the
        // documented crash path for streams, so the cast is deliberate.
        ;(process as unknown as NodeJS.EventEmitter).emit("error", unexpected as Error)
      })
    })
  process.stdout.on("error", onError)
  process.stderr.on("error", onError)
  return defaultState
}

/** True once the process-level guard has seen a reader close the pipe. */
export function stdoutPipeBroken(): boolean {
  return defaultState.stdoutBroken
}

/**
 * Forget the installed listeners and the broken-pipe flags.
 *
 * Test-only: `installStreamGuard` attaches its listeners to whatever
 * `process.stdout` is at the time, and a test that injects a failing stream has
 * to install *on that stream* to observe the guard's decision. Resetting lets
 * each case start from the same state instead of inheriting the previous one.
 * Not part of the CLI contract and never called by production code.
 */
export function resetStreamGuard(): void {
  installed = false
  defaultState.stdoutBroken = false
  defaultState.stderrBroken = false
}

/** Options for {@link writeGuarded}; the state defaults to the process guard. */
export interface WriteGuardedOptions {
  /** State to read/mark; injectable so tests never touch the real process pipes. */
  state?: StreamGuardState
}

/**
 * Write through a stream while applying the guard's verdict.
 *
 * Once the pipe is marked broken the write is skipped entirely: continuing would
 * only queue bytes nobody reads and keep firing `EPIPE`.
 *
 * A synchronous `EPIPE` is accepted (the reader is gone, not an error). Every
 * other synchronous failure is **re-thrown**, so it reaches the same `report`
 * that handles any other command error and keeps its existing message and exit
 * code — a full disk must never be reclassified as a closed pipe.
 */
export function writeGuarded(stream: Writable, text: string, options: WriteGuardedOptions = {}): void {
  const state = options.state ?? defaultState
  const broken = stream === process.stderr ? state.stderrBroken : state.stdoutBroken
  if (broken) return
  try {
    stream.write(text)
  } catch (error) {
    if (isEpipeError(error)) {
      state.stdoutBroken = true
      state.stderrBroken = true
      return
    }
    throw error
  }
}
