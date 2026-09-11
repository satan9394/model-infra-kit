/**
 * `mik` command dispatch — one parsed invocation → its command runner.
 *
 * Extracted from cli/index.ts so the REPL can reuse the dispatch (slash
 * commands) without reaching back into index.ts. Dependency direction is now
 * `index → repl → dispatch` and `index → dispatch`; dispatch must never
 * import repl.ts — the bare-`mik` (no-command) branch, including the
 * TTY→REPL fork, stays in index.ts.
 */
import { parseCliArgs, type ParsedCli } from "./args.js"
import { invocationLang, messageOf, resolveIo, type CliIo, type RunOptions } from "./context.js"
import { CliUsageError } from "./errors.js"
import { tr, type Lang } from "./i18n.js"
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

export function helpFor(parsed: ParsedCli, lang: Lang = "en"): string {
  if (parsed.command && parsed.action) return renderActionHelp(parsed.command, parsed.action, lang)
  if (parsed.command) return renderCommandHelp(parsed.command, lang)
  return renderRootHelp(lang)
}

/** Map an error to a user-facing message and process exit code. */
export function report(error: unknown, io: CliIo, lang: Lang = "en"): number {
  if (error instanceof CliUsageError) {
    io.err(`${tr(lang, "cli.errorPrefix")} ${redact(error.message)}`)
    if (error.usage) io.err(`${tr(lang, "cli.usagePrefix")} ${error.usage}`)
    return EXIT_USAGE
  }
  io.err(`${tr(lang, "cli.errorPrefix")} ${redact(messageOf(error))}`)
  return EXIT_FAILURE
}

/** Route one already-parsed invocation to its command runner. */
export async function dispatch(parsed: ParsedCli, options: RunOptions): Promise<number> {
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
      // Defensive: `parseCliArgs` already rejects an unknown command, so this is
      // only reachable for a `CommandSpec` no runner was registered for.
      throw new CliUsageError(
        tr(invocationLang(options), "cli.unknownCommand", parsed.command?.name ?? ""),
        "mik --help",
      )
  }
}

/**
 * Result of the shared invocation preamble: either a short-circuit exit code
 * (parse error, `--version`, `--help`) or the parsed invocation to route.
 */
export type PreparedInvocation =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "parsed"; readonly parsed: ParsedCli }

/**
 * The preamble every entry shares (EVO-G11 / G19): parse argv, then short-circuit
 * on `--version` and `--help`.
 *
 * `main` (index.ts) and `runCommand` had these ~10 lines duplicated; both now
 * call this. Nothing about the observed behaviour changed — version/help still
 * print and exit `EXIT_OK`, a parse failure still goes through `report`, and the
 * no-command branch is deliberately **not** handled here because the TTY→REPL
 * fork belongs to index.ts (see the module header).
 */
export function prepareInvocation(argv: readonly string[], io: CliIo, lang: Lang = "en"): PreparedInvocation {
  let parsed: ParsedCli
  try {
    parsed = parseCliArgs(argv, lang)
  } catch (error) {
    return { kind: "exit", code: report(error, io, lang) }
  }

  if (parsed.version) {
    io.out(renderVersion())
    return { kind: "exit", code: EXIT_OK }
  }
  if (parsed.help) {
    io.out(helpFor(parsed, lang))
    return { kind: "exit", code: EXIT_OK }
  }
  return { kind: "parsed", parsed }
}

/**
 * Parse argv and run one command (version/help included). Convenience entry
 * for the REPL's slash commands, which always carry a command; the bare-`mik`
 * (no-command) branch — TTY→REPL / non-TTY→root help — is owned by index.ts.
 */
export async function runCommand(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const io = resolveIo(options)
  const lang = invocationLang(options)
  const prepared = prepareInvocation(argv, io, lang)
  if (prepared.kind === "exit") return prepared.code

  try {
    const { parsed } = prepared
    if (!parsed.command) {
      // No-command handling lives in index.ts (it owns the TTY→REPL fork).
      // Mirror the non-TTY fallback so this entry stays deterministic: the
      // REPL never calls it without a command, and this matches `main`'s
      // non-interactive bare-`mik` output.
      io.out(helpFor(parsed, lang))
      return EXIT_OK
    }
    return await dispatch(parsed, options)
  } catch (error) {
    return report(error, io, lang)
  }
}