import { COMMANDS, GLOBAL_FLAGS, type ActionSpec, type CommandSpec, type FlagSpec } from "./args.js"
import { readVersion } from "./version.js"

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

export function renderRootHelp(): string {
  const commands = COMMANDS.map((command) => `  ${command.name.padEnd(12)}${command.summary}`)
  return [
    `model-infra-kit (mik) ${readVersion()}`,
    "Embeddable model layer: multi-provider access, model catalog, token usage and cost tracking.",
    "",
    "USAGE",
    "  mik <command> [options]",
    "",
    "COMMANDS",
    ...commands,
    "",
    "GLOBAL OPTIONS",
    ...flagBlock(GLOBAL_FLAGS),
    "",
    "EXAMPLES",
    "  mik init --app-id my-app --provider deepseek",
    "  mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY",
    "  mik provider test deepseek",
    "  mik models --provider deepseek --refresh",
    "  mik pricing set deepseek-chat --input 0.27 --output 1.10",
    "  mik usage summary --from 2026-09-01",
    "  mik usage export --format csv --out usage.csv",
    "",
    "Run \"mik <command> --help\" for details on any command.",
  ].join("\n")
}

export function renderCommandHelp(command: CommandSpec): string {
  const lines = [`mik ${command.name} — ${command.summary}`, "", "USAGE", `  ${command.usage}`]
  if (command.actions) {
    lines.push("", "ACTIONS")
    const width = Math.max(0, ...command.actions.map((action) => action.name.length))
    for (const action of command.actions) {
      lines.push(`  ${action.name.padEnd(width)}  ${action.summary}`)
    }
  }
  if (command.flags && command.flags.length > 0) {
    lines.push("", "OPTIONS", ...flagBlock(command.flags))
  }
  lines.push("", "GLOBAL OPTIONS", ...flagBlock(GLOBAL_FLAGS))
  if (command.details) lines.push("", ...command.details)
  return lines.join("\n")
}

export function renderActionHelp(command: CommandSpec, action: ActionSpec): string {
  const lines = [`mik ${command.name} ${action.name} — ${action.summary}`, "", "USAGE", `  ${action.usage}`]
  if (action.flags && action.flags.length > 0) lines.push("", "OPTIONS", ...flagBlock(action.flags))
  lines.push("", "GLOBAL OPTIONS", ...flagBlock(GLOBAL_FLAGS))
  if (action.details) lines.push("", ...action.details)
  return lines.join("\n")
}

export function renderVersion(): string {
  return `mik ${readVersion()}`
}
