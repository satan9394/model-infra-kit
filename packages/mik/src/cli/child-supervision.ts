import { spawnSync } from "node:child_process"
import { redact } from "../util/redact.js"

/**
 * Lifecycle supervision for a long-running child process (today: the Next.js
 * dashboard behind `mik dashboard`).
 *
 * The CLI must never leave the process it started behind. On Windows the real
 * tree is `pnpm.cmd → node → next`, so killing the direct child is not enough:
 * the whole tree has to go, which is what `taskkill /T /F` does. Everywhere
 * else a `SIGTERM` with a short `SIGKILL` grace period is enough.
 */

/** The slice of `ChildProcess` supervision actually needs. */
export interface SupervisedChild {
  pid?: number
  kill: (signal?: NodeJS.Signals) => boolean
}

/**
 * The slice of `process` supervision touches. The real `process` satisfies this
 * structurally; the signatures are kept plain (rather than a `Pick<NodeJS.Process>`
 * with its `this`-returning overloads) so a light fake can be injected in tests.
 */
export interface SupervisionHost {
  on: (event: string, listener: () => void) => unknown
  once: (event: string, listener: () => void) => unknown
  platform: NodeJS.Platform
  off?: (event: string, listener: () => void) => unknown
  removeListener?: (event: string, listener: () => void) => unknown
}

export interface SuperviseOptions {
  /** Defaults to `process.platform`; injectable so tests can cover both strategies. */
  platform?: NodeJS.Platform
  /** Defaults to `child.kill(signal)`. */
  kill?: (child: SupervisedChild, signal: NodeJS.Signals) => void
  /** Defaults to `spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"])`. */
  execTaskkill?: (pid: number) => void
  /** Defaults to the real `process`; injectable so tests never touch real signals. */
  processObject?: SupervisionHost
}

/** How long a `SIGTERM`ed child gets to exit before supervision escalates to `SIGKILL`. */
export const SIGKILL_GRACE_MS = 200

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Kill a process tree. `taskkill` is Windows-only, so it is only ever reached
 * on `win32`; a failure here (missing binary, denied access) is reported to the
 * caller, which falls back to `child.kill()`.
 */
function defaultTaskkill(pid: number): void {
  const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
  if (result.error) {
    throw result.error
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`taskkill exited with status ${result.status}`)
  }
}

/**
 * Tie a long-running child's lifetime to the parent's.
 *
 * - `SIGINT`/`SIGTERM` → terminate the child tree (Windows: `taskkill /T /F`;
 *   elsewhere: `SIGTERM`, then `SIGKILL` after {@link SIGKILL_GRACE_MS}).
 * - parent `exit` → terminate once, synchronously (timers cannot run there).
 * - idempotent: repeated signals or repeated cleanup never throw, and the child
 *   is never signalled twice by supervision.
 *
 * The signal listeners are registered with `once` on purpose: after the first
 * delivery supervision steps aside, so a second Ctrl+C keeps its default
 * meaning (immediate exit) instead of being swallowed by our handler.
 *
 * @returns `dispose()` — detaches every listener and cancels the pending
 * escalation. It does *not* kill the child; call it once the child has exited.
 */
export function superviseChild(child: SupervisedChild, options: SuperviseOptions = {}): () => void {
  const processObject = options.processObject ?? process
  const platform = options.platform ?? processObject.platform ?? process.platform
  const kill = options.kill ?? ((target, signal) => target.kill(signal))
  const execTaskkill = options.execTaskkill ?? defaultTaskkill

  let handled = false
  let disposed = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined

  const warn = (message: string): void => {
    console.warn(redact(message))
  }

  const safeKill = (signal: NodeJS.Signals): void => {
    try {
      kill(child, signal)
    } catch (error) {
      warn(`Could not signal the supervised child process: ${messageOf(error)}`)
    }
  }

  /** Terminate at most once; `withEscalation` schedules the `SIGKILL` fallback. */
  const terminate = (withEscalation: boolean): void => {
    if (handled) return
    handled = true

    const pid = child.pid
    if (platform === "win32" && typeof pid === "number" && pid > 0) {
      try {
        execTaskkill(pid)
      } catch (error) {
        warn(`taskkill failed for pid ${pid} (${messageOf(error)}); falling back to kill(SIGKILL).`)
        safeKill("SIGKILL")
      }
      return
    }

    safeKill("SIGTERM")
    if (!withEscalation) return
    graceTimer = setTimeout(() => {
      safeKill("SIGKILL")
    }, SIGKILL_GRACE_MS)
    // An unref'd timer never keeps the parent alive on its own.
    ;(graceTimer as { unref?: () => void }).unref?.()
  }

  const onSignal = (): void => {
    terminate(true)
  }

  const onParentExit = (): void => {
    // `exit` handlers must be synchronous: no grace period, just the kill.
    terminate(false)
  }

  /** `off` is the modern name; `removeListener` is the fallback for minimal fakes. */
  const detach = (event: string, listener: () => void): void => {
    if (processObject.off) processObject.off(event, listener)
    else processObject.removeListener?.(event, listener)
  }

  processObject.once("SIGINT", onSignal)
  processObject.once("SIGTERM", onSignal)
  processObject.once("exit", onParentExit)

  return function dispose(): void {
    if (disposed) return
    disposed = true
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
    detach("SIGINT", onSignal)
    detach("SIGTERM", onSignal)
    detach("exit", onParentExit)
  }
}
