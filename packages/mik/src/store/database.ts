import { accessSync, constants, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { ModelInfraError, isModelInfraError } from "../errors.js"
import { redact } from "../util/redact.js"
import { nodeSqliteDriver, type SqlDriver, type SqlDriverFactory, type SqlStatement } from "./driver.js"
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

/** Probe table created and rolled back on open; never survives a successful `open()`. */
const WRITE_PROBE_TABLE = "__mik_write_probe"

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function storageError(message: string, cause?: unknown): ModelInfraError {
  return new ModelInfraError(redact(message), { code: "STORAGE", cause })
}

/** SQLite contention is not a read-only database: opening must not fail because a peer is writing. */
function isBusyFailure(error: unknown): boolean {
  if (isModelInfraError(error)) return isBusyFailure(error.cause)
  const record = error as { code?: unknown; message?: unknown } | null | undefined
  const code = typeof record?.code === "string" ? record.code : ""
  const message = typeof record?.message === "string" ? record.message : ""
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(`${code} ${message}`)
}

/** Every SQLite failure leaving the driver becomes a `STORAGE` `ModelInfraError`, `cause` intact. */
function guard<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (isModelInfraError(error)) throw error
    throw storageError(`SQLite storage error: ${describeCause(error)}`, error)
  }
}

function guardStatement(statement: SqlStatement): SqlStatement {
  return {
    run: (...params: unknown[]) => guard(() => statement.run(...params)),
    get: (...params: unknown[]) => guard(() => statement.get(...params)),
    all: (...params: unknown[]) => guard(() => statement.all(...params)),
  }
}

/**
 * Wrap a raw driver so repositories never see a bare `ERR_SQLITE_ERROR`. Without
 * this, a read-only or locked database surfaced as an untyped throw that
 * `ModelInfra`'s warning path swallowed, silently dropping usage rows.
 */
function wrapDriverErrors(driver: SqlDriver): SqlDriver {
  return {
    exec: (sql: string) => guard(() => driver.exec(sql)),
    prepare: (sql: string) => guardStatement(guard(() => driver.prepare(sql))),
    close: () => guard(() => driver.close()),
  }
}

/**
 * Cheap permission check before SQLite is involved: a read-only file (Windows
 * `attrib +R`, POSIX `chmod 444`) fails here with a message that names the path.
 */
function assertWritableFile(path: string): void {
  if (path === ":memory:" || !existsSync(path)) return
  try {
    accessSync(path, constants.W_OK)
  } catch (error) {
    throw storageError(`Database is not writable: ${path}`, error)
  }
}

/**
 * Prove the database accepts a write. `PRAGMA`/`BEGIN IMMEDIATE` alone are not
 * enough: on a read-only file both succeed and only a real write fails. The DDL
 * runs inside a transaction that is always rolled back, so nothing persists.
 */
function assertWritableDatabase(driver: SqlDriver, path: string): void {
  try {
    driver.exec("BEGIN IMMEDIATE")
    try {
      driver.exec(`CREATE TABLE IF NOT EXISTS ${WRITE_PROBE_TABLE} (id INTEGER)`)
    } finally {
      driver.exec("ROLLBACK")
    }
  } catch (error) {
    if (isBusyFailure(error)) return
    throw storageError(`Database is not writable: ${path}`, error)
  }
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

  /**
   * Open (creating if needed) the usage database. Throws `ModelInfraError` with
   * code `STORAGE` when the file cannot be opened or written, so a read-only or
   * locked database fails loudly at startup instead of dropping rows later.
   */
  static async open(options: StoreOptions = {}): Promise<Store> {
    const path = options.path === ":memory:" ? ":memory:" : expandPath(options.path ?? defaultDbPath())
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    assertWritableFile(path)

    let raw: SqlDriver
    try {
      raw = await (options.driver ?? nodeSqliteDriver)(path)
    } catch (error) {
      throw storageError(`Could not open the database at ${path}: ${describeCause(error)}`, error)
    }

    const driver = wrapDriverErrors(raw)
    try {
      assertWritableDatabase(driver, path)
      const version = migrate(driver)
      return new Store(driver, path, version)
    } catch (error) {
      try {
        driver.close()
      } catch {
        // The open failure is the interesting one; a failing close must not mask it.
      }
      throw error
    }
  }

  close(): void {
    this.driver.close()
  }
}
