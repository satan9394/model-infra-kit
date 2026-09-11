#!/usr/bin/env node
/**
 * `mik` — the model-infra-kit command line.
 *
 * Design constraints from `tasks/T06-cli.md`: Node built-ins only (no CLI
 * framework), human-readable output, and never a secret on stdout.
 *
 * Dependency direction (EVO-G03): `index → repl → dispatch` and
 * `index → dispatch` — repl.ts reaches the dispatch through dispatch.ts, so
 * there is no index↔repl cycle.
 */
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { invocationLang, messageOf, resolveIo, type RunOptions } from "./context.js"
import { EXIT_FAILURE, EXIT_OK, dispatch, helpFor, prepareInvocation, report } from "./dispatch.js"
import { resolveCliLang, tr } from "./i18n.js"
import { isInteractive } from "./prompt.js"
import { runRepl } from "./repl.js"
import { redact } from "../util/redact.js"

/** Run one CLI invocation. Returns the process exit code; never calls `process.exit`. */
export async function main(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const io = resolveIo(options)
  // Help and usage errors are rendered before the hub exists, so the language
  // comes from the environment alone (same chain as the REPL/init guards).
  const lang = invocationLang(options)
  // Shared preamble with runCommand (EVO-G11 / G19): parse → version → help.
  const prepared = prepareInvocation(argv, io, lang)
  if (prepared.kind === "exit") return prepared.code

  try {
    const { parsed } = prepared
    if (!parsed.command) {
      // Bare `mik` with a terminal enters the guided REPL (slash commands with
      // bilingual descriptions). Without a TTY it falls back to root help.
      if (isInteractive(options)) return await runRepl(parsed, options)
      io.out(helpFor(parsed, lang))
      return EXIT_OK
    }
    return await dispatch(parsed, options)
  } catch (error) {
    return report(error, io, lang)
  }
}

/** True when this module is the process entry point (the `mik` bin). */
export function isDirectInvocation(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1]
  if (!entry) return false
  try {
    // npm's Unix bin entry is a **symlink** to dist/cli.mjs, so `process.argv[1]`
    // is the link path while `import.meta.url` is the resolved real path. Compare
    // resolved paths, or `mik` would silently do nothing on Linux/macOS. On
    // Windows the .cmd shim passes the real path, so this is an identity there.
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isDirectInvocation()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      // Last-resort handler for an unexpected rejection: there is no injected
      // `RunOptions` here, so the language comes from the real process env.
      const prefix = tr(resolveCliLang(process.env, undefined), "cli.errorPrefix")
      process.stderr.write(`${prefix} ${redact(messageOf(error))}\n`)
      process.exitCode = EXIT_FAILURE
    },
  )
}

export { parseCliArgs, COMMANDS, GLOBAL_FLAGS } from "./args.js"
export type { CliValues, ParsedCli, ActionSpec, CommandSpec, FlagSpec } from "./args.js"
export { formatMoney, formatTokens, formatPercent, formatDuration, formatTable, formatTimestamp } from "./format.js"
export { USAGE_CSV_COLUMNS, USAGE_CSV_HEADER, usageCsv, usageCsvRow } from "./csv.js"
export { assertPortFree, netstatShowsPort, portInUse, probePort } from "./ports.js"
export { openContext, withContext, offlineFetch, DEFAULT_CONFIG_FILE } from "./context.js"
export type { CliConfigFile, CliContext, CliIo, RunOptions } from "./context.js"
export { CliRuntimeError, CliUsageError } from "./errors.js"
export { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, helpFor } from "./dispatch.js"
