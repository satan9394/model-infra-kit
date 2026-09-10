import { parseArgs } from "node:util"
import { CliUsageError } from "./errors.js"

export interface FlagSpec {
  /** Long flag name without the leading dashes, e.g. `api-key-ref`. */
  name: string
  type: "string" | "boolean"
  short?: string
  placeholder?: string
  description: string
}

export interface ActionSpec {
  name: string
  summary: string
  usage: string
  /** Positional arguments, e.g. `<id>`. */
  args?: string
  flags?: readonly FlagSpec[]
  details?: readonly string[]
}

export interface CommandSpec {
  name: string
  summary: string
  usage: string
  flags?: readonly FlagSpec[]
  actions?: readonly ActionSpec[]
  details?: readonly string[]
}

export type CliValues = Record<string, string | boolean | undefined>

export interface ParsedCli {
  command: CommandSpec | null
  action: ActionSpec | null
  /** Positionals left after the command and action names. */
  args: string[]
  values: CliValues
  help: boolean
  version: boolean
  raw: readonly string[]
}

const FLAG_DB: FlagSpec = {
  name: "db",
  type: "string",
  placeholder: "<path>",
  description: "SQLite database file (default ~/.model-infra-kit/usage.db)",
}
const FLAG_APP_ID: FlagSpec = {
  name: "app-id",
  type: "string",
  placeholder: "<id>",
  description: "Owning application id (default: default)",
}
const FLAG_CONFIG: FlagSpec = {
  name: "config",
  type: "string",
  placeholder: "<path>",
  description: "CLI config file (default ./mik.config.json)",
}
const FLAG_CACHE_DIR: FlagSpec = {
  name: "cache-dir",
  type: "string",
  placeholder: "<path>",
  description: "Pricing catalogue cache directory",
}
const FLAG_OFFLINE: FlagSpec = {
  name: "offline",
  type: "boolean",
  description: "Never touch the network (skip catalogue sync and provider probes)",
}
const FLAG_HELP: FlagSpec = { name: "help", type: "boolean", short: "h", description: "Show help" }
const FLAG_VERSION: FlagSpec = { name: "version", type: "boolean", short: "v", description: "Show version" }

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  FLAG_DB,
  FLAG_APP_ID,
  FLAG_CONFIG,
  FLAG_CACHE_DIR,
  FLAG_OFFLINE,
  FLAG_HELP,
  FLAG_VERSION,
]

const FLAG_PORT_SERVE: FlagSpec = { name: "port", type: "string", placeholder: "<n>", description: "Listen port (default 3211)" }
const FLAG_HOST: FlagSpec = { name: "host", type: "string", placeholder: "<host>", description: "Bind host (default 127.0.0.1)" }
const FLAG_TOKEN: FlagSpec = {
  name: "token",
  type: "string",
  placeholder: "<token>",
  description: "Require Authorization: Bearer <token> on the HTTP API",
}
const FLAG_CORS: FlagSpec = {
  name: "cors",
  type: "string",
  placeholder: "<origin>",
  description:
    "Allow cross-origin browser access; use '*' for any origin, or a specific origin like https://app.example (default: off)",
}
const FLAG_PORT_DASHBOARD: FlagSpec = {
  name: "port",
  type: "string",
  placeholder: "<n>",
  description: "Dashboard port (default 3210)",
}
const FLAG_DIR: FlagSpec = {
  name: "dir",
  type: "string",
  placeholder: "<path>",
  description: "Dashboard app directory (default: auto-detected apps/dashboard)",
}
const FLAG_PROVIDER_PRESET: FlagSpec = {
  name: "preset",
  type: "string",
  placeholder: "<presetId>",
  description: "Provider preset, e.g. deepseek (fills protocol, base URL and env var)",
}
const FLAG_BASE_URL: FlagSpec = {
  name: "base-url",
  type: "string",
  placeholder: "<url>",
  description: "Endpoint override",
}
const FLAG_API_KEY_REF: FlagSpec = {
  name: "api-key-ref",
  type: "string",
  placeholder: "<ref>",
  description: "Credential reference: env:VAR, file:path or keychain:service (never a plaintext key)",
}
const FLAG_NAME: FlagSpec = { name: "name", type: "string", placeholder: "<name>", description: "Display name" }
const FLAG_PROTOCOL: FlagSpec = {
  name: "protocol",
  type: "string",
  placeholder: "<p>",
  description: "Wire protocol (openai-compatible | openai | anthropic | google | deepseek | moonshotai | xai)",
}
const FLAG_YES: FlagSpec = { name: "yes", type: "boolean", short: "y", description: "Do not ask for confirmation" }
const FLAG_FORCE: FlagSpec = { name: "force", type: "boolean", description: "Overwrite an existing config file" }
const FLAG_INIT_PROVIDER: FlagSpec = {
  name: "provider",
  type: "string",
  placeholder: "<presetId>",
  description: "First provider preset to register",
}
const FLAG_INIT_FILE: FlagSpec = {
  name: "file",
  type: "string",
  placeholder: "<path>",
  description: "Config file to write (default ./mik.config.json)",
}
const FLAG_PROVIDER_FILTER: FlagSpec = {
  name: "provider",
  type: "string",
  placeholder: "<id>",
  description: "Only this provider",
}
const FLAG_REFRESH: FlagSpec = {
  name: "refresh",
  type: "boolean",
  description: "Re-discover models from the provider API (needs network and a key)",
}
const FLAG_PRICE_INPUT: FlagSpec = {
  name: "input",
  type: "string",
  placeholder: "<usd/M>",
  description: "Input price per million tokens",
}
const FLAG_PRICE_OUTPUT: FlagSpec = {
  name: "output",
  type: "string",
  placeholder: "<usd/M>",
  description: "Output price per million tokens",
}
const FLAG_PRICE_CACHE_READ: FlagSpec = {
  name: "cache-read",
  type: "string",
  placeholder: "<usd/M>",
  description: "Cache-read price per million tokens",
}
const FLAG_PRICE_CACHE_WRITE: FlagSpec = {
  name: "cache-write",
  type: "string",
  placeholder: "<usd/M>",
  description: "Cache-write price per million tokens",
}
const FLAG_DAYS: FlagSpec = {
  name: "days",
  type: "string",
  placeholder: "<n>",
  description: "Look back this many days (default 30)",
}
const FLAG_LIMIT: FlagSpec = {
  name: "limit",
  type: "string",
  placeholder: "<n>",
  description: "Maximum rows to return (default 20, max 1000)",
}
const FLAG_OFFSET: FlagSpec = {
  name: "offset",
  type: "string",
  placeholder: "<n>",
  description: "Rows to skip",
}
const FLAG_FORMAT: FlagSpec = {
  name: "format",
  type: "string",
  placeholder: "<fmt>",
  description: "Export format (csv)",
}
const FLAG_OUT: FlagSpec = {
  name: "out",
  type: "string",
  placeholder: "<path>",
  description: "Write to a file instead of stdout",
}
const FLAG_FROM: FlagSpec = {
  name: "from",
  type: "string",
  placeholder: "<date>",
  description: "Range start: YYYY-MM-DD, ISO timestamp or epoch ms",
}
const FLAG_TO: FlagSpec = {
  name: "to",
  type: "string",
  placeholder: "<date>",
  description: "Range end, inclusive when a plain date is given",
}
const FLAG_APP: FlagSpec = {
  name: "app",
  type: "string",
  placeholder: "<appId>",
  description: "Filter by owning application id",
}
const FLAG_MODEL: FlagSpec = {
  name: "model",
  type: "string",
  placeholder: "<id>",
  description: "Filter by model id",
}
const FLAG_STATUS: FlagSpec = {
  name: "status",
  type: "string",
  placeholder: "<ok|error>",
  description: "Filter by request status",
}

const QUERY_FLAGS: readonly FlagSpec[] = [FLAG_FROM, FLAG_TO, FLAG_APP, FLAG_PROVIDER_FILTER, FLAG_MODEL, FLAG_STATUS]

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "Write mik.config.json (app id, database path, first provider)",
    usage: "mik init [--app-id <id>] [--db <path>] [--provider <presetId>] [--file <path>] [--force] [--yes]",
    flags: [FLAG_INIT_PROVIDER, FLAG_INIT_FILE, FLAG_FORCE, FLAG_YES],
    details: [
      "Prompts when stdin is a terminal; otherwise it uses the flags and defaults.",
      "The first provider is registered in the database; the config only records",
      "the intent so a later run cannot resurrect a removed provider.",
    ],
  },
  {
    name: "serve",
    summary: "Start the OpenAI-compatible HTTP service (default 127.0.0.1:3211)",
    usage: "mik serve [--port 3211] [--host 127.0.0.1] [--token <token>] [--cors <origin>]",
    flags: [FLAG_PORT_SERVE, FLAG_HOST, FLAG_TOKEN, FLAG_CORS],
    details: [
      "Refuses to start when the port is already in use.",
      "Prefer the MIK_SERVER_TOKEN environment variable over --token: command-line",
      "arguments are visible to other processes. The token is never printed.",
      "--cors enables browser access: '*' for any origin, or a specific origin",
      "(https://app.example). Off by default, so browser code must go through a",
      "same-origin proxy unless --cors is given.",
    ],
  },
  {
    name: "dashboard",
    summary: "Start the dashboard app (default 3210)",
    usage: "mik dashboard [--port 3210] [--dir <path>]",
    flags: [FLAG_PORT_DASHBOARD, FLAG_DIR],
    details: ["Refuses to start when the port is already in use."],
  },
  {
    name: "provider",
    summary: "List, add, remove and test providers",
    usage: "mik provider <list|add|remove|test> [options]",
    actions: [
      {
        name: "list",
        summary: "List configured providers and the default model",
        usage: "mik provider list",
      },
      {
        name: "add",
        summary: "Add or update a provider (preset fills protocol, base URL and env var)",
        usage:
          "mik provider add <id> [--preset <presetId>] [--base-url <url>] [--api-key-ref <ref>] [--name <name>] [--protocol <p>]",
        args: "<id>",
        flags: [FLAG_PROVIDER_PRESET, FLAG_BASE_URL, FLAG_API_KEY_REF, FLAG_NAME, FLAG_PROTOCOL],
        details: [
          "Secrets are referenced, never stored: use --api-key-ref env:VAR or file:path.",
          "Without --api-key-ref the provider falls back to the preset's environment",
          "variable and the CLI says so instead of storing anything.",
        ],
      },
      {
        name: "remove",
        summary: "Remove a provider from the database",
        usage: "mik provider remove <id> [--yes]",
        args: "<id>",
        flags: [FLAG_YES],
      },
      {
        name: "test",
        summary: "Probe a provider with one minimal call",
        usage: "mik provider test <id>",
        args: "<id>",
      },
    ],
  },
  {
    name: "models",
    summary: "List the model catalogue, optionally refreshing it from the provider",
    usage: "mik models [--provider <id>] [--refresh]",
    flags: [FLAG_PROVIDER_FILTER, FLAG_REFRESH],
  },
  {
    name: "pricing",
    summary: "Inspect, sync and override model prices",
    usage: "mik pricing <list|sync|set> [options]",
    actions: [
      { name: "list", summary: "Show manual price overrides and the catalogue state", usage: "mik pricing list" },
      {
        name: "sync",
        summary: "Refresh the price catalogue from the network",
        usage: "mik pricing sync",
        details: ["Requires network access; --offline makes this fail fast."],
      },
      {
        name: "set",
        summary: "Set a manual price override for one model (outranks every catalogue)",
        usage: "mik pricing set <modelId> --input <usd/M> [--output <usd/M>] [--cache-read] [--cache-write] [--name <display>]",
        args: "<modelId>",
        flags: [FLAG_PRICE_INPUT, FLAG_PRICE_OUTPUT, FLAG_PRICE_CACHE_READ, FLAG_PRICE_CACHE_WRITE, FLAG_NAME],
        details: ["At least one of --input or --output is required."],
      },
    ],
  },
  {
    name: "usage",
    summary: "Query recorded usage: summary, trends, logs, CSV export",
    usage: "mik usage <summary|trends|logs|export> [options]",
    actions: [
      { name: "summary", summary: "Totals for the selected range", usage: "mik usage summary [--from <date>] [--to <date>] [--app <appId>]", flags: QUERY_FLAGS },
      {
        name: "trends",
        summary: "Per-day totals",
        usage: "mik usage trends [--days 30] [--from <date>] [--to <date>]",
        flags: [FLAG_DAYS, ...QUERY_FLAGS],
      },
      {
        name: "logs",
        summary: "Recent requests",
        usage: "mik usage logs [--limit 20] [--offset <n>] [--provider <id>] [--model <id>] [--status ok|error]",
        flags: [FLAG_LIMIT, FLAG_OFFSET, ...QUERY_FLAGS],
      },
      {
        name: "export",
        summary: "Export usage rows as CSV with a fixed header",
        usage: "mik usage export --format csv [--out <path>] [--from <date>] [--to <date>]",
        flags: [FLAG_FORMAT, FLAG_OUT, ...QUERY_FLAGS],
      },
    ],
  },
]

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name)
}

function buildSuperset(): Record<string, { type: "string" | "boolean"; short?: string }> {
  const options: Record<string, { type: "string" | "boolean"; short?: string }> = {}
  const add = (spec: FlagSpec): void => {
    const existing = options[spec.name]
    if (existing && existing.type !== spec.type) {
      throw new Error(`CLI flag --${spec.name} is declared with two different types.`)
    }
    options[spec.name] = spec.short ? { type: spec.type, short: spec.short } : { type: spec.type }
  }
  for (const spec of GLOBAL_FLAGS) add(spec)
  for (const command of COMMANDS) {
    for (const spec of command.flags ?? []) add(spec)
    for (const action of command.actions ?? []) for (const spec of action.flags ?? []) add(spec)
  }
  return options
}

const SUPERSET = buildSuperset()

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function allowedFlags(command: CommandSpec | null, action: ActionSpec | null): Set<string> {
  const names = new Set<string>(GLOBAL_FLAGS.map((spec) => spec.name))
  for (const spec of command?.flags ?? []) names.add(spec.name)
  for (const spec of action?.flags ?? []) names.add(spec.name)
  return names
}

/**
 * Parse `process.argv.slice(2)`.
 *
 * Flags are resolved against the whole command tree first (so an unknown flag
 * fails loudly), then checked against the resolved command and action (so a
 * known-but-misplaced flag, e.g. `--port` on `usage summary`, also fails).
 */
export function parseCliArgs(argv: readonly string[]): ParsedCli {
  let positionals: string[]
  let rawValues: Record<string, string | boolean | undefined>
  try {
    const parsed = parseArgs({ args: [...argv], options: SUPERSET, allowPositionals: true, strict: true })
    positionals = parsed.positionals
    rawValues = parsed.values as Record<string, string | boolean | undefined>
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error), "mik --help")
  }

  const help = rawValues.help === true
  const version = rawValues.version === true
  const commandName = positionals[0]

  if (commandName === undefined) {
    return { command: null, action: null, args: [], values: camelValues(rawValues), help, version, raw: argv }
  }

  const command = findCommand(commandName)
  if (!command) {
    throw new CliUsageError(
      `Unknown command "${commandName}". Run "mik --help" for the list of commands.`,
      "mik --help",
    )
  }

  let action: ActionSpec | null = null
  let args: string[]
  if (command.actions) {
    const actionName = positionals[1]
    if (actionName === undefined) {
      if (help) return { command, action: null, args: [], values: camelValues(rawValues), help, version, raw: argv }
      throw new CliUsageError(
        `"mik ${command.name}" needs an action: ${command.actions.map((item) => item.name).join(", ")}.`,
        command.usage,
      )
    }
    const found = command.actions.find((item) => item.name === actionName)
    if (!found) {
      if (help) return { command, action: null, args: [], values: camelValues(rawValues), help, version, raw: argv }
      throw new CliUsageError(
        `Unknown action "${command.name} ${actionName}". Expected one of: ${command.actions
          .map((item) => item.name)
          .join(", ")}.`,
        command.usage,
      )
    }
    action = found
    args = positionals.slice(2)
  } else {
    args = positionals.slice(1)
  }

  const allowed = allowedFlags(command, action)
  for (const name of Object.keys(rawValues)) {
    if (!allowed.has(name)) {
      throw new CliUsageError(`--${name} is not valid for "${[command.name, action?.name].filter(Boolean).join(" ")}".`, action?.usage ?? command.usage)
    }
  }

  return { command, action, args, values: camelValues(rawValues), help, version, raw: argv }
}

function camelValues(raw: Record<string, string | boolean | undefined>): CliValues {
  const values: CliValues = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) values[camelCase(name)] = value
  }
  return values
}

export function flagString(values: CliValues, key: string): string | undefined {
  const value = values[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

export function flagBool(values: CliValues, key: string): boolean {
  return values[key] === true
}

export function flagNumber(values: CliValues, key: string, usage?: string): number | undefined {
  const raw = flagString(values, key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new CliUsageError(`--${key} expects a number, got "${raw}".`, usage)
  return value
}

export function requireFlagNumber(values: CliValues, key: string, usage?: string): number {
  const value = flagNumber(values, key, usage)
  if (value === undefined) throw new CliUsageError(`--${key} is required.`, usage)
  return value
}
