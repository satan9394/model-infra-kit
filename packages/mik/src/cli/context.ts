import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ModelInfra, type ModelInfraOptions } from "../hub.js"
import type { ProviderConfig } from "../types.js"
import { defaultDbPath } from "../util/paths.js"
import { redact } from "../util/redact.js"
import { flagBool, flagString, type ParsedCli } from "./args.js"
import { CliUsageError } from "./errors.js"

export const DEFAULT_CONFIG_FILE = "mik.config.json"

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

export interface RunOptions {
  io?: Partial<CliIo>
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Tests set this to force the non-interactive path. */
  interactive?: boolean
}

export interface CliConfigFile {
  appId?: string
  db?: string
  /**
   * Consumed by `mik init` only. Keeping it out of the regular command path is
   * deliberate: a config file that re-seeded providers on every run would
   * resurrect a provider the user had just removed.
   */
  initialProviders?: ProviderConfig[]
}

export interface CliContext {
  hub: ModelInfra
  io: CliIo
  env: NodeJS.ProcessEnv
  cwd: string
  offline: boolean
  appId: string
  dbPath: string
  configPath: string
  config: CliConfigFile
  close: () => void
}

const stdoutIo: CliIo = {
  out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
}

export function resolveIo(options: RunOptions): CliIo {
  return { out: options.io?.out ?? stdoutIo.out, err: options.io?.err ?? stdoutIo.err }
}

export function resolveEnv(options: RunOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env
}

export function resolveCwd(options: RunOptions): string {
  return options.cwd ?? process.cwd()
}

/** A `fetch` that always fails, so `--offline` cannot accidentally reach out. */
export const offlineFetch: typeof globalThis.fetch = async (input) => {
  throw new Error(`offline mode: refusing to fetch ${typeof input === "string" ? input : "the network"}`)
}

export function configPathFor(parsed: ParsedCli, options: RunOptions = {}): string {
  const env = resolveEnv(options)
  const cwd = resolveCwd(options)
  return flagString(parsed.values, "config") ?? env.MIK_CONFIG ?? join(cwd, DEFAULT_CONFIG_FILE)
}

export function loadConfig(path: string, io: CliIo): CliConfigFile {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      io.err(`warning: ${path} is not a JSON object; ignoring it.`)
      return {}
    }
    const record = parsed as Record<string, unknown>
    const config: CliConfigFile = {}
    if (typeof record.appId === "string" && record.appId) config.appId = record.appId
    if (typeof record.db === "string" && record.db) config.db = record.db
    if (Array.isArray(record.initialProviders)) config.initialProviders = record.initialProviders as ProviderConfig[]
    return config
  } catch (error) {
    io.err(`warning: could not read ${path} (${redact(messageOf(error))}); ignoring it.`)
    return {}
  }
}

export interface OpenContextOptions extends RunOptions {
  /** Extra hub options, e.g. an injected catalogue for tests. */
  hub?: Partial<ModelInfraOptions>
}

/**
 * Open the store and wire the facade.
 *
 * Precedence for `db` and `appId`: CLI flag → environment → `mik.config.json`
 * → built-in default. `--offline` also disables the background catalogue sync,
 * so no command in a test can reach the network.
 */
export async function openContext(parsed: ParsedCli, options: OpenContextOptions = {}): Promise<CliContext> {
  const io = resolveIo(options)
  const env = resolveEnv(options)
  const cwd = resolveCwd(options)
  const configPath = configPathFor(parsed, options)
  const config = loadConfig(configPath, io)

  const dbPath = flagString(parsed.values, "db") ?? env.MIK_DB ?? config.db ?? defaultDbPath()
  const appId = flagString(parsed.values, "appId") ?? env.MIK_APP_ID ?? config.appId ?? "default"
  const cacheDir = flagString(parsed.values, "cacheDir") ?? env.MIK_CACHE_DIR
  const offline = flagBool(parsed.values, "offline") || env.MIK_OFFLINE === "1"

  const hub = await ModelInfra.init({
    appId,
    db: dbPath,
    cacheDir,
    syncCatalog: !offline,
    pricingFetch: offline ? offlineFetch : undefined,
    onWarn: (message, error) => io.err(`warning: ${redact(message)}${error ? ` (${redact(messageOf(error))})` : ""}`),
    ...options.hub,
  })

  return {
    hub,
    io,
    env,
    cwd,
    offline,
    appId,
    dbPath,
    configPath,
    config,
    close: () => hub.close(),
  }
}

/** Run a command body with a context that is always closed afterwards. */
export async function withContext<T>(
  parsed: ParsedCli,
  options: OpenContextOptions,
  body: (context: CliContext) => Promise<T>,
): Promise<T> {
  const context = await openContext(parsed, options)
  try {
    return await body(context)
  } finally {
    context.close()
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A required positional argument, or a usage error naming it. */
export function requireArg(parsed: ParsedCli, index: number, name: string): string {
  const value = parsed.args[index]
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(`Missing required argument ${name}.`, parsed.action?.usage ?? parsed.command?.usage)
  }
  return value
}
