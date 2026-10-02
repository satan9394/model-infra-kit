import { adaptSqlDriver, type StorageAdapter, type PreparedStatement } from "./adapter.js"
import { nodeSqliteDriver } from "./driver.js"

/** Default zero-dependency adapter; connection PRAGMAs live in nodeSqliteDriver. */
export class SqliteStorageAdapter implements StorageAdapter {
  private constructor(private readonly adapter: StorageAdapter) {}

  static async open(path: string): Promise<SqliteStorageAdapter> {
    return new SqliteStorageAdapter(adaptSqlDriver(await nodeSqliteDriver(path)))
  }

  exec(sql: string): void { this.adapter.exec(sql) }
  prepare<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): PreparedStatement<T> { return this.adapter.prepare<T>(sql) }
  transaction<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T { return this.adapter.transaction(fn) }
  close(): void { this.adapter.close() }
}
