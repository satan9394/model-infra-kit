/**
 * EVO-G70 (G61) — targeted suppression of one noisy Node warning.
 *
 * `node:sqlite` is imported lazily (see `store/driver.ts`) and Node announces it
 * once per process:
 *
 * ```
 * (node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time
 * ```
 *
 * That line is true but useless on every run of every command, and it lands on
 * stderr next to the CLI's own output. The suppression is **targeted**, never
 * global (card §G61 hard constraint): exactly `ExperimentalWarning` whose
 * message mentions SQLite is dropped, every other warning is handed to the
 * listeners that were installed before the filter — including Node's own default
 * reporter — so a future `DeprecationWarning`/security warning still reaches the
 * user. `removeAllListeners("warning")` on its own is forbidden for that reason.
 *
 * Deliberately installed at the CLI entry point (`cli/index.ts`), not in the
 * library: a host that embeds `mik` owns its own process diagnostics.
 *
 * Platform note: the shebang variant (`#!/usr/bin/env -S node
 * --disable-warning=ExperimentalWarning`) only works on Unix — npm's generated
 * `.cmd` shim on Windows does not parse shebangs — so this in-process filter is
 * the cross-platform path (card §G61 option 2).
 */

/** The one warning this filter is allowed to drop. */
const SUPPRESSED_NAME = "ExperimentalWarning"
const SUPPRESSED_MESSAGE = /SQLite/i

/** True for the `node:sqlite` experimental notice and nothing else. */
export function isSuppressedWarning(warning: unknown): boolean {
  if (!warning || typeof warning !== "object") return false
  const record = warning as { name?: unknown; message?: unknown }
  if (record.name !== SUPPRESSED_NAME) return false
  return typeof record.message === "string" && SUPPRESSED_MESSAGE.test(record.message)
}

/**
 * Park the current `warning` listeners, put the filter in their place, and return
 * the restore function those listeners will be called from. Callers keep the
 * returned function and always run it in a `finally` (same shape as
 * `serveBanner`'s SIGINT parking in the i18n tests).
 *
 * When nothing was parked — possible in an embedded process that removed its own
 * listeners — the filter prints the warning itself instead of forwarding it, so
 * "not the sqlite notice" always means "still visible". Silence must never be the
 * result of installing this filter.
 */
export function installWarningFilter(): () => void {
  const parked = process.listeners("warning")
  process.removeAllListeners("warning")
  process.on("warning", (warning: unknown) => {
    if (isSuppressedWarning(warning)) return
    if (parked.length === 0) {
      process.stderr.write(`(node:${process.pid}) ${String(warning)}\n`)
      return
    }
    for (const listener of parked) (listener as (warning: unknown) => void)(warning)
  })
  return () => {
    process.removeAllListeners("warning")
    for (const listener of parked) process.on("warning", listener)
  }
}
