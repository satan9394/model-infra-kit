import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ModelInfra, type ModelInfraOptions } from "../hub.js"
import type { ProviderConfig } from "../types.js"
import { defaultDbPath } from "../util/paths.js"
import { writeGuarded } from "../util/pipe.js"
import { redact } from "../util/redact.js"
import { flagBool, flagString, type ParsedCli } from "./args.js"
import { CliUsageError } from "./errors.js"
import { resolveCliLang, tr, type Lang } from "./i18n.js"

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
  /** Settles once the hub's store is closed; always await it. */
  close: () => Promise<void>
}

/**
 * The default terminal IO — the single chokepoint every command's output passes
 * through (`resolveIo`). Both writers go through `writeGuarded`, so a downstream
 * reader that closed early (`| head -1`, `| grep -q`) is handled in one place
 * instead of in each command (EVO-G76).
 */
const stdoutIo: CliIo = {
  out: (text) => writeGuarded(process.stdout, text.endsWith("\n") ? text : `${text}\n`),
  err: (text) => writeGuarded(process.stderr, text.endsWith("\n") ? text : `${text}\n`),
}

/**
 * The IO one invocation writes through.
 *
 * A caller that injects `io` (tests, embedders) keeps full control: only the
 * missing side falls back to the guarded terminal writer. The `out` field of the
 * default writer is read at write time, so the bin entry can install the guard
 * (`src/util/pipe.ts`) after this object was built without losing protection.
 */
export function resolveIo(options: RunOptions): CliIo {
  return { out: options.io?.out ?? stdoutIo.out, err: options.io?.err ?? stdoutIo.err }
}

export function resolveEnv(options: RunOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env
}

/**
 * Language for one invocation, before the hub (and therefore `cli.lang`) exists:
 * `MIK_LANG` → OS locale → `en`. Same chain as `repl.ts` (non-TTY guard) and
 * `init.ts` (early guard), so help, usage errors and the REPL can never disagree.
 */
export function invocationLang(options: RunOptions): Lang {
  return resolveCliLang(resolveEnv(options), undefined)
}

/**
 * Language for a *command body*, once the hub (and therefore `cli.lang`) exists:
 * `MIK_LANG` → stored `cli.lang` → OS locale → `en` — the same chain `init.ts`
 * and `repl.ts` use, so a `/lang zh` REPL session cannot get English tables out
 * of `/providers`. The env always comes from `options.env`, never the real
 * `process.env`, so a test that injects `MIK_LANG` keeps control (EVO-G12).
 *
 * Flag/usage errors raised *before* the hub open still use `invocationLang`
 * (there is no store yet to consult).
 */
export function contextLang(context: CliContext, options: RunOptions): Lang {
  return resolveCliLang(resolveEnv(options), context.hub.readSetting("cli.lang") ?? undefined)
}

export function resolveCwd(options: RunOptions): string {
  return options.cwd ?? process.cwd()
}

/**
 * A `fetch` that always fails, so `--offline` cannot accidentally reach out.
 *
 * The message is deliberately short, untranslated and stable: it is embedded in
 * a `warning:` line whose body comes from the caller (`llm-pricing`).
 */
export const offlineFetch: typeof globalThis.fetch = async (input) => {
  throw new Error(`offline mode: refusing to fetch ${typeof input === "string" ? input : "the network"}`)
}

export function configPathFor(parsed: ParsedCli, options: RunOptions = {}): string {
  const env = resolveEnv(options)
  const cwd = resolveCwd(options)
  return flagString(parsed.values, "config") ?? env.MIK_CONFIG ?? join(cwd, DEFAULT_CONFIG_FILE)
}

/**
 * Read `mik.config.json`.
 *
 * `options` (or an explicit `lang`) carries the invocation's language, so a
 * caller that injects `MIK_LANG=zh` gets a Chinese warning even on an English
 * host. `loadConfig` runs *before* the hub exists, so it uses
 * `invocationLang(options)` — never the real `process.env` (EVO-G12/G14).
 */
export function loadConfig(path: string, io: CliIo, options: RunOptions = {}, lang: Lang = invocationLang(options)): CliConfigFile {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      io.err(tr(lang, "context.warning.notObject", path))
      return {}
    }
    const record = parsed as Record<string, unknown>
    const config: CliConfigFile = {}
    if (typeof record.appId === "string" && record.appId) config.appId = record.appId
    if (typeof record.db === "string" && record.db) config.db = record.db
    if (Array.isArray(record.initialProviders)) config.initialProviders = record.initialProviders as ProviderConfig[]
    return config
  } catch (error) {
    io.err(tr(lang, "context.warning.unreadable", path, redact(messageOf(error))))
    return {}
  }
}

/**
 * Whether this invocation actually needs the model catalogue refreshed from the
 * provider. Only `serve`, `dashboard`, an explicit `models --refresh` and
 * `pricing sync` do; every read-only command (`provider list/remove`,
 * `models` without `--refresh`, `pricing list`, `usage *`, `init`, ...) runs with
 * `syncCatalog: false` so a background sync can never print a `warning:` line
 * next to its output or race the store close.
 */
export function needsCatalogSync(parsed: ParsedCli): boolean {
  switch (parsed.command?.name) {
    case "serve":
    case "dashboard":
      return true
    case "models":
      return flagBool(parsed.values, "refresh")
    case "pricing":
      return parsed.action?.name === "sync"
    default:
      return false
  }
}

/**
 * The `warning:` line for one library warning (EVO-G70/G60).
 *
 * Extracted so the dedupe rule is directly testable: the library reports a
 * failure by embedding its cause in the body *and* handing the cause over as the
 * second argument (`ai/bridge.ts`), so appending the cause unconditionally
 * printed the same sentence twice on one line. The parenthesis is only appended
 * when the cause is **not already part of the body** — a genuinely different
 * cause still reaches the user, and both halves go through `redact`.
 */
export function formatWarning(lang: Lang, message: string, error?: unknown): string {
  const body = redact(message)
  const cause = error === undefined ? "" : redact(messageOf(error))
  const detail = cause && !body.includes(cause) ? ` (${cause})` : ""
  return `${tr(lang, "context.warning.prefix")} ${body}${detail}`
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
 * so no command in a test can reach the network. Commands that do not read the
 * catalogue keep the sync off as well (`needsCatalogSync`).
 */
export async function openContext(parsed: ParsedCli, options: OpenContextOptions = {}): Promise<CliContext> {
  const io = resolveIo(options)
  const env = resolveEnv(options)
  const cwd = resolveCwd(options)
  // The hub does not exist yet, so the language can only come from the injected
  // invocation environment (`RunOptions.env`) — never the real `process.env`.
  // Same chain as `init`/the REPL's early guards, so warnings and usage errors
  // can never disagree (EVO-G12/G14).
  const lang = invocationLang(options)
  const configPath = configPathFor(parsed, options)
  const config = loadConfig(configPath, io, options, lang)

  const dbPath = flagString(parsed.values, "db") ?? env.MIK_DB ?? config.db ?? defaultDbPath()
  const appId = flagString(parsed.values, "appId") ?? env.MIK_APP_ID ?? config.appId ?? "default"
  const cacheDir = flagString(parsed.values, "cacheDir") ?? env.MIK_CACHE_DIR
  const offline = flagBool(parsed.values, "offline") || env.MIK_OFFLINE === "1"

  const hub = await ModelInfra.init({
    appId,
    db: dbPath,
    cacheDir,
    syncCatalog: !offline && needsCatalogSync(parsed),
    pricingFetch: offline ? offlineFetch : undefined,
    // Only the `warning:` frame is localized; a warning's *message* may come from
    // a third-party library (`llm-pricing`) and is deliberately passed through
    // untranslated — see the G14 report for that known cross-layer debt.
    //
    // EVO-G70 (G60): `formatWarning` drops the parenthetical when the cause text
    // is already part of the body, so the same sentence stops printing twice.
    onWarn: (message, error) => io.err(formatWarning(lang, message, error)),
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
    // Awaited: the store must be closed before the command reports success, and
    // a still-running background sync must not outlive the process.
    await context.close()
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A required positional argument, or a usage error naming it.
 *
 * `options` carries the invocation's environment, so the message localizes from
 * the *injected* env (`RunOptions.env`) rather than the real `process.env` — a
 * caller that passes `MIK_LANG=zh` must get Chinese even on an English host.
 * Passing an explicit `lang` still wins (tests).
 */
export function requireArg(
  parsed: ParsedCli,
  index: number,
  name: string,
  options: RunOptions = {},
  lang: Lang = invocationLang(options),
): string {
  const value = parsed.args[index]
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(tr(lang, "cli.missingArgument", name), parsed.action?.usage ?? parsed.command?.usage)
  }
  return value
}
