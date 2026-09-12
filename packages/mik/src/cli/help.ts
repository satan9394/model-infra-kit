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
 *
 * EVO-G58 extends that to the *descriptions*: each flag carries an optional
 * `descriptionKey`, and a command/action `details` line is looked up as
 * `help.details.<command>[.<action>].<index>`. Both go through `text()`, whose
 * fallback is the `args.ts` literal — so a missing key means English (never a
 * blank column) and English output stays byte-identical.
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

function flagBlock(flags: readonly FlagSpec[], lang: Lang): string[] {
  const lines = flags.map(flagLine)
  const width = Math.max(0, ...lines.map((line) => line.length))
  // The description column is localized (EVO-G58); the column width is computed
  // from the flag names only, so alignment cannot shift with the language.
  return flags.map((spec, index) => {
    const description = text(lang, spec.descriptionKey ?? "", spec.description)
    return `${(lines[index] ?? "").padEnd(width)}  ${description}`
  })
}

/**
 * Localized `details` paragraph for a command (`help.details.serve.4`) or an
 * action (`help.details.provider.add.1`).
 *
 * A line with no dictionary entry in either language keeps its literal: that is
 * how the embedded command examples (`mik provider add <id> --preset …`) stay
 * copy-pasteable instead of being translated into something unrunnable.
 */
function detailBlock(stem: string, details: readonly string[] | undefined, lang: Lang): string[] {
  if (!details) return []
  return details.map((line, index) => text(lang, `${stem}.${index}`, line))
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
    ...flagBlock(GLOBAL_FLAGS, lang),
    "",
    text(lang, "help.heading.examples", "EXAMPLES"),
    "  mik init --app-id my-app --provider <presetId>",
    "  mik provider add <id> --preset <presetId> --api-key-ref env:<ENV_VAR>",
    "  mik provider test <id>",
    "  mik serve --token $MIK_SERVER_TOKEN",
    "  curl -s http://127.0.0.1:3211/v1/models   # after \"mik models --refresh\": ids for \"<provider>:<model>\"",
    "  curl -s http://127.0.0.1:3211/v1/chat/completions -H \"Authorization: Bearer $MIK_SERVER_TOKEN\" -H \"Content-Type: application/json\" -d '{\"model\":\"<provider>:<model>\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'",
    "  mik models --provider <id> --refresh",
    "  mik pricing set <modelId> --input 0.27 --output 1.10",
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
    lines.push("", text(lang, "help.heading.options", "OPTIONS"), ...flagBlock(command.flags, lang))
  }
  lines.push("", text(lang, "help.heading.globalOptions", "GLOBAL OPTIONS"), ...flagBlock(GLOBAL_FLAGS, lang))
  if (command.details) lines.push("", ...detailBlock(`help.details.${command.name}`, command.details, lang))
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
    lines.push("", text(lang, "help.heading.options", "OPTIONS"), ...flagBlock(action.flags, lang))
  }
  lines.push("", text(lang, "help.heading.globalOptions", "GLOBAL OPTIONS"), ...flagBlock(GLOBAL_FLAGS, lang))
  if (action.details) {
    lines.push("", ...detailBlock(`help.details.${command.name}.${action.name}`, action.details, lang))
  }
  return lines.join("\n")
}

export function renderVersion(): string {
  return `mik ${readVersion()}`
}
