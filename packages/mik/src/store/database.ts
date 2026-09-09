import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { nodeSqliteDriver, type SqlDriver, type SqlDriverFactory } from "./driver.js"
import { migrate } from "./schema.js"
import { ModelRepository } from "./model-repository.js"
import { PricingRepository, SettingsRepository } from "./pricing-repository.js"
import { ProviderRepository } from "./provider-repository.js"
import { UsageRepository } from "./usage-repository.js"
import { defaultDbPath, expandPath } from "../util/paths.js"

export interface StoreOptions {
  /** SQLite file, or `:memory:`. Defaults to `~/.model-infra-kit/usage.db`. */
  path?: string
  /** Inject an alternative SQLite driver (better-sqlite3, bun:sqlite). */
  driver?: SqlDriverFactory
}

/** The persistence layer. Everything a host stores lives here. */
export class Store {
  readonly providers: ProviderRepository
  readonly models: ModelRepository
  readonly pricing: PricingRepository
  readonly usage: UsageRepository
  readonly settings: SettingsRepository
  readonly schemaVersion: number
  readonly path: string

  private constructor(
    readonly driver: SqlDriver,
    path: string,
    schemaVersion: number,
  ) {
    this.path = path
    this.schemaVersion = schemaVersion
    this.providers = new ProviderRepository(driver)
    this.models = new ModelRepository(driver)
    this.pricing = new PricingRepository(driver)
    this.usage = new UsageRepository(driver)
    this.settings = new SettingsRepository(driver)
  }

  static async open(options: StoreOptions = {}): Promise<Store> {
    const path = options.path === ":memory:" ? ":memory:" : expandPath(options.path ?? defaultDbPath())
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    const driver = await (options.driver ?? nodeSqliteDriver)(path)
    const version = migrate(driver)
    return new Store(driver, path, version)
  }

  close(): void {
    this.driver.close()
  }
}
