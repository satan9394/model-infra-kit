/**
 * The narrow SQLite surface this package needs. Implemented for `node:sqlite`
 * by default; a host may inject `better-sqlite3` or `bun:sqlite` instead.
 */
export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
}

export interface SqlDriver {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

export type SqlDriverFactory = (path: string) => SqlDriver | Promise<SqlDriver>

/**
 * `node:sqlite` driver. Node >= 22 ships it, so the default install needs no
 * native build step. Loaded through a dynamic import so hosts that inject
 * their own driver never load it.
 *
 * Note: Node still marks `node:sqlite` experimental and prints one warning on
 * first import. Silence it with `NODE_OPTIONS=--no-warnings` if it bothers you.
 */
export async function nodeSqliteDriver(path: string): Promise<SqlDriver> {
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => db.prepare(sql) as unknown as SqlStatement,
    close: () => db.close(),
  }
}

/** Values accepted by SQLite bindings after normalisation. */
export type SqlValue = string | number | bigint | null | Uint8Array

export function toSqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value
  if (value instanceof Uint8Array) return value
  if (typeof value === "boolean") return value ? 1 : 0
  return JSON.stringify(value)
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value)
}
