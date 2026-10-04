import { readFile } from "node:fs/promises"
import { watchFile, unwatchFile } from "node:fs"
import { ModelInfra, type ModelInfraOptions } from "../hub.js"
import { readRouterConfig } from "../ai/smart-router.js"
import { splitModelRef } from "../registry/registry.js"
import type { ProviderConfig } from "../types.js"
import { redact } from "../util/redact.js"
import { resolveTokens, type GatewayToken } from "./auth.js"

export interface ReloadOptions {
  configPath: string
  /** CLI flag/env precedence and offline settings. Storage cannot change live. */
  hubOptions: ModelInfraOptions
  env?: NodeJS.ProcessEnv
  watch?: boolean
  watchIntervalMs?: number
  token?: string
  onWarn?: (message: string) => void
  /** Active routing edits are the fallback when the file omits providers/default. */
  currentHub?: ModelInfra
  /** Original immutable file fields, before CLI flag/environment precedence. */
  immutableConfig?: { appId?: string; db?: string; cacheDir?: string; storage?: unknown }
}

export interface ReloadResult { reloaded: boolean; swapMicros?: number }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Validate completely before publishing any routing state. */
export async function prepareConfig(options: ReloadOptions): Promise<{ hub: ModelInfra; tokens: GatewayToken[] }> {
  const value: unknown = JSON.parse(await readFile(options.configPath, "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reload config must be an object.")
  const config = value as Record<string, unknown>
  const allowed = new Set(["appId", "db", "storage", "cacheDir", "budget", "serverTokens", "router", "initialProviders", "providers", "defaultModel", "watch"])
  if (Object.keys(config).some(key => !allowed.has(key))) throw new Error("Unknown reload config field.")
  for (const key of ["appId", "db", "cacheDir", "defaultModel"]) {
    if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key])) throw new Error(`Invalid ${key} configuration.`)
  }
  const immutable = options.immutableConfig ?? options.hubOptions
  if (config.appId !== undefined && config.appId !== immutable.appId) throw new Error("Cannot change appId during reload.")
  if (config.db !== undefined && config.db !== immutable.db) throw new Error("Cannot change database during reload.")
  if (config.cacheDir !== undefined && config.cacheDir !== immutable.cacheDir) throw new Error("Cannot change cache directory during reload.")
  if (config.storage !== undefined && JSON.stringify(config.storage) !== JSON.stringify(immutable.storage)) throw new Error("Cannot change storage during reload.")
  if (config.watch !== undefined && typeof config.watch !== "boolean") throw new Error("Invalid watch configuration.")
  if (config.providers !== undefined && config.initialProviders !== undefined) throw new Error("Use only one provider configuration field.")
  const supplied = config.providers ?? config.initialProviders
  if (supplied !== undefined && !Array.isArray(supplied)) throw new Error("Providers must be an array.")
  const ids = new Set<string>()
  if (supplied) for (const item of supplied as unknown[]) {
    if (!object(item) || typeof item.id !== "string" || ids.has(item.id)) throw new Error("Invalid or duplicate provider configuration.")
    ids.add(item.id)
    const record = item
    const fields = new Set(["id", "name", "presetId", "protocol", "baseUrl", "apiKeyRef", "npmPackage", "enabled", "meta", "group", "priority", "fallback_provider_id"])
    if (Object.keys(record).some(key => !fields.has(key))) throw new Error("Unknown provider field; credentials must use references.")
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error("Invalid provider enabled flag.")
    for (const key of ["name", "presetId", "protocol", "baseUrl", "npmPackage"]) {
      if (record[key] !== undefined && (typeof record[key] !== "string" || !record[key])) throw new Error(`Invalid provider ${key}.`)
    }
    if (item.baseUrl) {
      const url = new URL(item.baseUrl as string)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid provider URL.")
    }
    if (item.apiKeyRef !== undefined) {
      const refs = Array.isArray(item.apiKeyRef) ? item.apiKeyRef : [item.apiKeyRef]
      if (!refs.length || refs.some(ref => typeof ref !== "string" || !/^(env|file|keychain):.+$/.test(ref))) throw new Error("Provider credentials require references.")
    }
  }
  const providers = supplied as ProviderConfig[] | undefined
  if (config.budget !== undefined) {
    if (!config.budget || typeof config.budget !== "object" || Array.isArray(config.budget)) throw new Error("Invalid budget configuration.")
    for (const [key, amount] of Object.entries(config.budget)) {
      if (["dailyMicros", "monthlyMicros"].includes(key)) {
        if (!Number.isSafeInteger(amount) || (amount as number) <= 0) throw new Error("Reload budgets require positive integer micros.")
      } else if (!((key === "currency" && amount === "USD") || (key === "window" && ["day", "month"].includes(String(amount))) || (key === "onExceed" && amount === "warn"))) {
        throw new Error("Invalid reload budget field; use integer micros.")
      }
    }
  }
  const env = { ...(options.env ?? process.env) }
  if (Array.isArray(config.serverTokens)) for (const entry of config.serverTokens) {
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["tokenRef", "scopes", "appId"].includes(key))) throw new Error("Invalid gateway token reference fields.")
  }
  const tokens = resolveTokens(config.serverTokens, env)
  if (options.token) {
    if (tokens.some(entry => entry.token === options.token)) throw new Error("Duplicate gateway token configuration.")
    tokens.push({ token: options.token, scopes: ["admin"] })
  }
  const router = config.router === undefined ? undefined : readRouterConfig(config.router)
  const hub = await ModelInfra.init({
    ...options.hubOptions, env,
    providers: providers ?? options.currentHub?.providers.list() ?? options.hubOptions.providers,
    defaultModel: (config.defaultModel as string | undefined) ?? options.currentHub?.providers.defaultModel() ?? options.hubOptions.defaultModel,
    router,
    budget: config.budget as ModelInfraOptions["budget"],
    isolatedProviders: true, syncCatalog: false, pricingAutoSync: false,
  })
  try {
    if (router) for (const policy of Object.values(router.aliases)) for (const target of [policy.default_target, ...policy.rules.map(rule => rule.target)]) {
      const parsed = splitModelRef(target.includes(":") ? target : hub.providers.defaultModel() ?? "")
      if (!parsed || !hub.providers.get(parsed.providerId)?.enabled) throw new Error("Router target requires an enabled provider.")
    }
  } catch (error) { await hub.close(); throw error }
  return { hub, tokens }
}

interface Generation<T> { value: T; requests: number; retired: boolean; disposed?: Promise<void>; drained: Promise<void>; finish: () => void }
function generation<T>(value: T): Generation<T> {
  let finish!: () => void
  const drained = new Promise<void>(resolve => { finish = resolve })
  return { value, requests: 0, retired: false, drained, finish }
}

/** Serialized preparation, constant-time publication, and natural response drain. */
export class HotReloadManager<T> {
  private active: Generation<T>
  private readonly generations = new Set<Generation<T>>()
  private pending: Promise<ReloadResult> | undefined
  private stopped = false
  private listening = false
  private stopWatch: (() => void) | undefined
  private dirty = false
  private readonly onSignal = () => { this.scheduleReload() }

  constructor(initial: T, private readonly prepare: () => Promise<T>, private readonly dispose: (value: T) => void | Promise<void>, private readonly warn: (message: string) => void = () => {}) {
    this.active = generation(initial)
    this.generations.add(this.active)
  }

  get activeContext(): T { return this.active.value }

  private scheduleReload(): void {
    if (this.stopped) return
    if (this.pending) { this.dirty = true; return }
    void this.reloadConfig()
  }

  acquire(): { context: T; release: () => void } {
    if (this.stopped) throw new Error("Reload manager is closed.")
    const generation = this.active
    generation.requests += 1
    let released = false
    return { context: generation.value, release: () => {
      if (released) return
      released = true
      generation.requests -= 1
      this.drain(generation)
    } }
  }

  reloadConfig(): Promise<ReloadResult> {
    if (this.stopped) return Promise.resolve({ reloaded: false })
    if (this.pending) return this.pending
    this.pending = (async () => {
      try {
        const value = await this.prepare()
        if (this.stopped) { await this.dispose(value); return { reloaded: false } }
        const previous = this.active
        const next = generation(value)
        this.generations.add(next)
        const start = process.hrtime.bigint()
        this.active = next
        const swapMicros = Number(process.hrtime.bigint() - start) / 1000
        previous.retired = true
        this.drain(previous)
        return { reloaded: true, swapMicros }
      } catch {
        // Parsing errors may echo raw file contents, including unknown secrets.
        try { this.warn(redact("Configuration reload failed; retaining the previous configuration.")) } catch {}
        return { reloaded: false }
      } finally {
        this.pending = undefined
        if (this.dirty) { this.dirty = false; queueMicrotask(() => this.scheduleReload()) }
      }
    })()
    return this.pending
  }

  listen(configPath: string, watch: boolean, interval = 250): void {
    if (this.listening || this.stopped) return
    this.listening = true
    process.on("SIGHUP", this.onSignal)
    if (watch) {
      const listener = (current: import("node:fs").Stats, previous: import("node:fs").Stats) => {
        if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) this.scheduleReload()
      }
      watchFile(configPath, { interval, persistent: false }, listener)
      this.stopWatch = () => unwatchFile(configPath, listener)
    }
  }

  private drain(generation: Generation<T>): void {
    if (!generation.retired || generation.requests || generation.disposed) return
    generation.disposed = Promise.resolve().then(() => this.dispose(generation.value)).catch(() => {}).then(() => { this.generations.delete(generation); generation.finish() })
  }

  async close(): Promise<void> {
    this.stopped = true
    process.off("SIGHUP", this.onSignal)
    this.stopWatch?.()
    await this.pending
    for (const generation of this.generations) { generation.retired = true; this.drain(generation) }
    await Promise.all([...this.generations].map(generation => generation.drained))
  }
}
