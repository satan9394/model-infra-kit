#!/usr/bin/env node
/**
 * `mik` — the model-infra-kit command line.
 *
 * Design constraints from `tasks/T06-cli.md`: Node built-ins only (no CLI
 * framework), human-readable output, and never a secret on stdout.
 */
import { pathToFileURL } from "node:url"
import { parseCliArgs, type ParsedCli } from "./args.js"
import { messageOf, resolveIo, type CliIo, type RunOptions } from "./context.js"
import { CliUsageError } from "./errors.js"
import { renderActionHelp, renderCommandHelp, renderRootHelp, renderVersion } from "./help.js"
import { runDashboard } from "./commands/dashboard.js"
import { runInit } from "./commands/init.js"
import { runModels } from "./commands/models.js"
import { runPricing } from "./commands/pricing.js"
import { runProvider } from "./commands/provider.js"
import { runServe } from "./commands/serve.js"
import { runUsage } from "./commands/usage.js"
import { redact } from "../util/redact.js"

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

export function helpFor(parsed: ParsedCli): string {
  if (parsed.command && parsed.action) return renderActionHelp(parsed.command, parsed.action)
  if (parsed.command) return renderCommandHelp(parsed.command)
  return renderRootHelp()
}

function report(error: unknown, io: CliIo): number {
  if (error instanceof CliUsageError) {
    io.err(`error: ${redact(error.message)}`)
    if (error.usage) io.err(`usage: ${error.usage}`)
    return EXIT_USAGE
  }
  io.err(`error: ${redact(messageOf(error))}`)
  return EXIT_FAILURE
}

async function dispatch(parsed: ParsedCli, options: RunOptions): Promise<number> {
  switch (parsed.command?.name) {
    case "init":
      return runInit(parsed, options)
    case "serve":
      return runServe(parsed, options)
    case "dashboard":
      return runDashboard(parsed, options)
    case "provider":
      return runProvider(parsed, options)
    case "models":
      return runModels(parsed, options)
    case "pricing":
      return runPricing(parsed, options)
    case "usage":
      return runUsage(parsed, options)
    default:
      throw new CliUsageError(`Unknown command "${parsed.command?.name ?? ""}".`, "mik --help")
  }
}

/** Run one CLI invocation. Returns the process exit code; never calls `process.exit`. */
export async function main(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const io = resolveIo(options)
  let parsed: ParsedCli
  try {
    parsed = parseCliArgs(argv)
  } catch (error) {
    return report(error, io)
  }

  try {
    if (parsed.version) {
      io.out(renderVersion())
      return EXIT_OK
    }
    if (parsed.help || !parsed.command) {
      io.out(helpFor(parsed))
      return EXIT_OK
    }
    return await dispatch(parsed, options)
  } catch (error) {
    return report(error, io)
  }
}

/** True when this module is the process entry point (the `mik` bin). */
export function isDirectInvocation(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
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
      process.stderr.write(`error: ${redact(messageOf(error))}\n`)
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
