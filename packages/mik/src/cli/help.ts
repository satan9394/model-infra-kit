import { COMMANDS, GLOBAL_FLAGS, type ActionSpec, type CommandSpec, type FlagSpec } from "./args.js"
import { tr, type Lang } from "./i18n.js"
import { readVersion } from "./version.js"

/**
 * Framework text for the `--help` frame (EVO-G12).
 *
 * The language is resolved by the caller — the CLI entry renders help *before*
 * the hub (and therefore `cli.lang`) exists, so it can only use
 * `resolveCliLang(env, undefined)`. The default `"en"` keeps every existing
 * embedder call (`renderRootHelp()`) byte-identical.
 *
 * Only the frame is translated: command names, flag names and the `usage:`
 * examples stay English because they are copy-pasteable literals.
 */
function text(lang: Lang, key: string, fallback: string): string {
  const translated = tr(lang, key)
  return translated === "" ? fallback : translated
}

/** Localized one-line summary for a command, falling back to `args.ts`. */
function commandSummary(command: CommandSpec, lang: Lang): string {
  return text(lang, `cmd.${command.name}.summary`, command.summary)
}

/** Localized one-line summary for an action (`mik provider --help` → ACTIONS). */
function actionSummary(command: CommandSpec, action: ActionSpec, lang: Lang): string {
  return text(lang, `cmd.${command.name}.${action.name}.summary`, action.summary)
}

function flagLine(spec: FlagSpec): string {
  const short = spec.short ? `-${spec.short}, ` : "    "
  const value = spec.type === "string" ? ` ${spec.placeholder ?? "<value>"}` : ""
  return `  ${short}--${spec.name}${value}`
}

function flagBlock(flags: readonly FlagSpec[]): string[] {
  const lines = flags.map(flagLine)
  const width = Math.max(0, ...lines.map((line) => line.length))
  return flags.map((spec, index) => `${(lines[index] ?? "").padEnd(width)}  ${spec.description}`)
}

export function renderRootHelp(lang: Lang = "en"): string {
  const commands = COMMANDS.map((command) => `  ${command.name.padEnd(12)}${commandSummary(command, lang)}`)
  return [
    `model-infra-kit (mik) ${readVersion()}`,
    text(
      lang,
      "help.banner",
      "Embeddable model layer: multi-provider access, model catalog, token usage and cost tracking.",
    ),
    "",
    text(lang, "help.heading.usage", "USAGE"),
    "  mik <command> [options]",
    "",
    text(lang, "help.heading.commands", "COMMANDS"),
    ...commands,
    "",
    text(lang, "help.heading.globalOptions", "GLOBAL OPTIONS"),
    ...flagBlock(GLOBAL_FLAGS),
    "",
    text(lang, "help.heading.examples", "EXAMPLES"),
    "  mik init --app-id my-app --provider deepseek",
    "  mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY",
    "  mik provider test deepseek",
    "  mik models --provider deepseek --refresh",
    "  mik pricing set deepseek-chat --input 0.27 --output 1.10",
    "  mik usage summary --from 2026-09-01",
    "  mik usage export --format csv --out usage.csv",
    "",
    text(lang, "help.footer", "Run \"mik <command> --help\" for details on any command."),
  ].join("\n")
}

export function renderCommandHelp(command: CommandSpec, lang: Lang = "en"): string {
  const lines = [
    `mik ${command.name} — ${commandSummary(command, lang)}`,
    "",
    text(lang, "help.heading.usage", "USAGE"),
    `  ${command.usage}`,
  ]
  if (command.actions) {
    lines.push("", text(lang, "help.heading.actions", "ACTIONS"))
    const width = Math.max(0, ...command.actions.map((action) => action.name.length))
    for (const action of command.actions) {
      lines.push(`  ${action.name.padEnd(width)}  ${actionSummary(command, action, lang)}`)
    }
  }
  if (command.flags && command.flags.length > 0) {
    lines.push("", text(lang, "help.heading.options", "OPTIONS"), ...flagBlock(command.flags))
  }
  lines.push("", text(lang, "help.heading.globalOptions", "GLOBAL OPTIONS"), ...flagBlock(GLOBAL_FLAGS))
  if (command.details) lines.push("", ...command.details)
  return lines.join("\n")
}

export function renderActionHelp(command: CommandSpec, action: ActionSpec, lang: Lang = "en"): string {
  const lines = [
    `mik ${command.name} ${action.name} — ${actionSummary(command, action, lang)}`,
    "",
    text(lang, "help.heading.usage", "USAGE"),
    `  ${action.usage}`,
  ]
  if (action.flags && action.flags.length > 0) {
    lines.push("", text(lang, "help.heading.options", "OPTIONS"), ...flagBlock(action.flags))
  }
  lines.push("", text(lang, "help.heading.globalOptions", "GLOBAL OPTIONS"), ...flagBlock(GLOBAL_FLAGS))
  if (action.details) lines.push("", ...action.details)
  return lines.join("\n")
}

export function renderVersion(): string {
  return `mik ${readVersion()}`
}
