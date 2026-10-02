import { ModelInfraError } from "../errors.js"
import type { SqlDriver, SqlStatement } from "./driver.js"

/** SQLite-compatible SQL and synchronous operations preserve the public repository API. */
export interface PreparedStatement<T extends Record<string, unknown> = Record<string, unknown>> extends SqlStatement {
  get(...params: unknown[]): T | undefined
  all(...params: unknown[]): T[]
}

export interface StorageAdapter extends SqlDriver {
  prepare<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): PreparedStatement<T>
  /** The callback must finish synchronously; nested calls use savepoints. */
  transaction<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T
}

export type StorageConfig =
  | { type: "sqlite"; path?: string }
  | { type: "custom"; name: string; url?: string; authTokenRef?: string }
export type StorageAdapterFactory = (config: StorageConfig) => StorageAdapter | Promise<StorageAdapter>

/** Validate file configuration without ever accepting an inline database token. */
export function readStorageConfig(value: unknown): StorageConfig {
  const fail = (): never => { throw new ModelInfraError("Invalid storage configuration; use sqlite or an injected custom factory and token references.", { code: "INVALID_REQUEST" }) }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail()
  const row = value as Record<string, unknown>
  if (row.type === "sqlite") {
    if (Object.keys(row).some((key) => key !== "type" && key !== "path")) return fail()
    if (row.path !== undefined && (typeof row.path !== "string" || !row.path.trim())) return fail()
    return { type: "sqlite", path: row.path as string | undefined }
  }
  if (row.type !== "custom" || typeof row.name !== "string" || !row.name.trim()) return fail()
  if (Object.keys(row).some((key) => !["type", "name", "url", "authTokenRef"].includes(key))) return fail()
  if (row.url !== undefined) {
    if (typeof row.url !== "string") return fail()
    try {
      const url = new URL(row.url)
      if (url.username || url.password || url.search || url.hash) return fail()
    } catch { return fail() }
  }
  if (row.authTokenRef !== undefined && (typeof row.authTokenRef !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(row.authTokenRef))) return fail()
  return { type: "custom", name: row.name, url: row.url as string | undefined, authTokenRef: row.authTokenRef as string | undefined }
}

export function isStorageAdapter(value: unknown): value is StorageAdapter {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return ["exec", "prepare", "transaction", "close"].every((key) => typeof row[key] === "function")
}

/** Upgrade legacy SQLite drivers without changing their host-facing factory contract. */
export function adaptSqlDriver(driver: SqlDriver): StorageAdapter {
  let depth = 0
  let sequence = 0
  return {
    exec: (sql) => driver.exec(sql),
    prepare<T extends Record<string, unknown>>(sql: string): PreparedStatement<T> {
      const statement = driver.prepare(sql)
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params) as T | undefined,
        all: (...params) => statement.all(...params) as T[],
      }
    },
    close: () => driver.close(),
    transaction<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
      // Reject declared async functions before invocation so they cannot resume after rollback.
      if (Object.prototype.toString.call(fn) === "[object AsyncFunction]") throw new TypeError("Storage transactions require a synchronous callback")
      const nested = depth > 0
      const savepoint = `mik_transaction_${++sequence}`
      driver.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE")
      depth += 1
      try {
        const result = fn()
        if (result && typeof (result as { then?: unknown }).then === "function") throw new TypeError("Storage transactions require a synchronous callback")
        driver.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT")
        return result
      } catch (error) {
        driver.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK")
        if (nested) driver.exec(`RELEASE SAVEPOINT ${savepoint}`)
        throw error
      } finally {
        depth -= 1
      }
    },
  }
}
