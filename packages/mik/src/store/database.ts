import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { ModelInfraError, isModelInfraError } from "../errors.js"
import { redact } from "../util/redact.js"
import { nodeSqliteDriver, type SqlDriver, type SqlDriverFactory, type SqlStatement } from "./driver.js"
import { migrate } from "./schema.js"
import { quarantineDatabase, type QuarantineResult } from "./trash.js"
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
  /** Non-fatal notices: a skipped integrity check, or a corrupt ledger quarantined on open. */
  onWarn?: (message: string, error?: unknown) => void
  /**
   * Where a corrupt database is moved. Defaults to `~/.model-infra-kit/trash`,
   * the same quarantine root F04 uses for credentials.
   */
  trashDir?: string
  /** Override the integrity-check size budget (bytes). Exposed for tests. */
  maxIntegrityCheckBytes?: number
}

/** Probe table created and rolled back on open; never survives a successful `open()`. */
const WRITE_PROBE_TABLE = "__mik_write_probe"

/**
 * `PRAGMA quick_check` walks the whole file, so on a huge ledger it would delay
 * `ModelInfra.init()` — rule 6 says startup must not block. Above this size the
 * check is skipped and the write probe alone decides: we would rather miss
 * corruption than stall a host boot.
 */
const MAX_INTEGRITY_CHECK_BYTES = 64 * 1024 * 1024

/**
 * The only failures that mean "the bytes on disk are damaged". Permission, lock
 * and path errors say nothing about integrity, and reading one as corruption
 * would quarantine a perfectly good ledger — the exact opposite of the promise.
 */
const CORRUPTION_SIGNATURE =
  /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database|database corruption/i

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every message and `code` in the `cause` chain, so a wrapped driver error still matches. */
function causeText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code
    parts.push(typeof code === "string" ? code : "", current.message)
    current = current.cause
  }
  if (parts.length === 0) parts.push(String(error))
  return parts.join(" ")
}

function isCorruptionFailure(error: unknown): boolean {
  return CORRUPTION_SIGNATURE.test(causeText(error))
}

/** Closing must never mask the failure that made us close. */
function closeQuietly(driver: SqlDriver): void {
  try {
    driver.close()
  } catch {
    // The open failure is the interesting one; a failing close must not mask it.
  }
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
 *
 * Returns the corruption detail instead of throwing when the probe itself fails
 * with a corruption signature: a damaged header makes `CREATE TABLE` (which reads
 * `sqlite_master`) fail, and reporting that as "not writable" would hide the one
 * failure `open()` knows how to heal.
 */
function probeWritableDatabase(driver: SqlDriver, path: string): string | null {
  try {
    driver.exec("BEGIN IMMEDIATE")
    try {
      driver.exec(`CREATE TABLE IF NOT EXISTS ${WRITE_PROBE_TABLE} (id INTEGER)`)
    } finally {
      driver.exec("ROLLBACK")
    }
    return null
  } catch (error) {
    if (isBusyFailure(error)) return null
    if (isCorruptionFailure(error)) return describeCause(error)
    throw storageError(`Database is not writable: ${path}`, error)
  }
}

/**
 * `PRAGMA quick_check` on a file-backed database: cheaper than `integrity_check`
 * and enough to answer "is this ledger usable". Skipped for `:memory:` (nothing
 * can be damaged before it exists) and above the size budget (rule 6).
 *
 * An unrecognised failure is deliberately *not* corruption: the conservative
 * choice is to let the original error surface rather than move a possibly sound
 * file.
 */
/**
 * Paths whose size-budget skip has already been reported. A long-lived host opens
 * the same ledger many times (CLI invocations, repeated `init()`), and repeating an
 * informational notice on every open is noise, not signal — so it is once per
 * process per path. The set holds only the handful of ledgers a process touches.
 */
const skippedIntegrityNotices = new Set<string>()

function checkIntegrity(driver: SqlDriver, path: string, options: StoreOptions): string | null {
  if (path === ":memory:") return null

  const budget = options.maxIntegrityCheckBytes ?? MAX_INTEGRITY_CHECK_BYTES
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  if (size > budget) {
    if (!skippedIntegrityNotices.has(path)) {
      skippedIntegrityNotices.add(path)
      options.onWarn?.(
        redact(
          `Skipped the SQLite integrity check for ${path}: ${size} bytes exceeds the ${budget}-byte startup budget, ` +
            `and startup must not block. Corruption in a database this large goes undetected until SQLite itself complains.`,
        ),
      )
    }
    return null
  }

  let rows: Array<Record<string, unknown>>
  try {
    rows = driver.prepare("PRAGMA quick_check").all()
  } catch (error) {
    return isCorruptionFailure(error) ? describeCause(error) : null
  }

  const problems = rows
    .map((row) => String(Object.values(row)[0] ?? ""))
    .filter((value) => value !== "" && value.toLowerCase() !== "ok")
  return problems.length > 0 ? problems.join("; ") : null
}

/** One open attempt: either a migrated driver, or proof that the file is damaged. */
type OpenAttempt =
  | { kind: "ok"; driver: SqlDriver; version: number }
  | { kind: "corrupt"; detail: string }

async function connect(path: string, options: StoreOptions): Promise<OpenAttempt> {
  let raw: SqlDriver
  try {
    raw = await (options.driver ?? nodeSqliteDriver)(path)
  } catch (error) {
    // A damaged file usually fails inside the driver's own `PRAGMA journal_mode`
    // setup, before any driver object exists. That is still healable.
    if (path !== ":memory:" && isCorruptionFailure(error)) {
      return { kind: "corrupt", detail: describeCause(error) }
    }
    throw storageError(`Could not open the database at ${path}: ${describeCause(error)}`, error)
  }

  const driver = wrapDriverErrors(raw)
  try {
    const probeCorruption = probeWritableDatabase(driver, path)
    if (probeCorruption !== null) {
      closeQuietly(driver)
      return { kind: "corrupt", detail: probeCorruption }
    }
    const integrityCorruption = checkIntegrity(driver, path, options)
    if (integrityCorruption !== null) {
      closeQuietly(driver)
      return { kind: "corrupt", detail: integrityCorruption }
    }
    return { kind: "ok", driver, version: migrate(driver) }
  } catch (error) {
    closeQuietly(driver)
    throw error
  }
}

/** The one-line guidance a user needs to get their ledger back. */
function corruptionWarning(path: string, detail: string, quarantined: QuarantineResult): string {
  const rescued = join(quarantined.dir, basename(path))
  return (
    `ALERT: the SQLite ledger at ${path} was corrupt (${detail}) and has been quarantined at ${quarantined.dir}. ` +
    `Nothing was deleted. A new empty database was created, so the ledger is reset to zero rows and metering continues. ` +
    `Recover the old rows with a SQLite tool, for example: ` +
    `sqlite3 "${rescued}" ".recover" | sqlite3 recovered.db`
  )
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
   *
   * A *corrupt* file is the one failure that does not reach the host: the damaged
   * bytes are moved (never deleted) into `~/.model-infra-kit/trash/db-corrupt-…`,
   * an empty ledger is created in their place and `onWarn` says loudly where the
   * old data went. A host that would otherwise refuse to boot now boots.
   */
  static async open(options: StoreOptions = {}): Promise<Store> {
    const path = options.path === ":memory:" ? ":memory:" : expandPath(options.path ?? defaultDbPath())
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    assertWritableFile(path)

    const first = await connect(path, options)
    if (first.kind === "ok") return new Store(first.driver, path, first.version)
    if (path === ":memory:") {
      throw storageError(`Could not open the in-memory database: ${first.detail}`)
    }

    let quarantined: QuarantineResult
    try {
      quarantined = quarantineDatabase(path, { trashDir: options.trashDir })
    } catch (error) {
      // The old ledger is still exactly where it was: a failed quarantine must
      // never turn into data loss, so this stays fatal and says so.
      throw storageError(
        `The database at ${path} is corrupt (${first.detail}) and could not be moved to the trash directory: ` +
          `${describeCause(error)}. Nothing was deleted — the damaged file is still there; move it aside yourself to start fresh.`,
        error,
      )
    }

    const second = await connect(path, options)
    if (second.kind === "corrupt") {
      throw storageError(
        `The database at ${path} is still corrupt after quarantine (${second.detail}). ` +
          `The damaged file is preserved at ${quarantined.dir}.`,
      )
    }

    options.onWarn?.(redact(corruptionWarning(path, first.detail, quarantined)))
    return new Store(second.driver, path, second.version)
  }

  close(): void {
    this.driver.close()
  }
}
