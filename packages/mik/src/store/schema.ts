import type { SqlDriver } from "./driver.js"

/**
 * One migration step: plain SQL, or a function for the rare step that has to
 * look at the schema first (SQLite has no `ALTER TABLE … ADD COLUMN IF NOT
 * EXISTS`).
 */
type MigrationStatement = string | ((driver: SqlDriver) => void)

interface Migration {
  version: number
  statements: MigrationStatement[]
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT,
        api_key_ref TEXT,
        npm_package TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        preset_id TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_providers_app ON providers(app_id)`,
      `CREATE TABLE IF NOT EXISTS provider_models (
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        context_window INTEGER,
        max_output_tokens INTEGER,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      )`,
      `CREATE TABLE IF NOT EXISTS pricing_overrides (
        model_id TEXT PRIMARY KEY,
        display_name TEXT,
        input_per_m REAL,
        output_per_m REAL,
        cache_read_per_m REAL,
        cache_write_per_m REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS usage_events (
        request_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_requested TEXT NOT NULL DEFAULT '',
        model_actual TEXT NOT NULL DEFAULT '',
        pricing_model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_low_usd REAL NOT NULL DEFAULT 0,
        cost_high_usd REAL NOT NULL DEFAULT 0,
        pricing_source TEXT,
        pricing_basis TEXT,
        latency_ms INTEGER,
        first_token_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'ok',
        error_code TEXT,
        is_streaming INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        tags_json TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts)`,
      `CREATE INDEX IF NOT EXISTS idx_usage_app_ts ON usage_events(app_id, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_usage_provider_ts ON usage_events(provider_id, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_usage_model_ts ON usage_events(model_actual, ts)`,
      `CREATE TABLE IF NOT EXISTS usage_daily_rollups (
        date TEXT NOT NULL,
        app_id TEXT NOT NULL,
        source TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_microusd INTEGER NOT NULL DEFAULT 0,
        cost_low_microusd INTEGER NOT NULL DEFAULT 0,
        cost_high_microusd INTEGER NOT NULL DEFAULT 0,
        latency_sum_ms INTEGER NOT NULL DEFAULT 0,
        latency_count INTEGER NOT NULL DEFAULT 0,
        first_token_sum_ms INTEGER NOT NULL DEFAULT 0,
        first_token_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, app_id, source, provider_id, model)
      )`,
      `CREATE TABLE IF NOT EXISTS credentials (
        ref TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
  {
    // EVO-G75 — attribution tags. Purely additive, on purpose: no existing
    // column changes and no row is rewritten, so a database created by an
    // earlier version upgrades in place with every row intact.
    version: 2,
    statements: [
      /**
       * Belt and braces for a database that predates `tags_json` and whose
       * table was therefore never created by this module's own v1 (`v1` uses
       * `CREATE TABLE IF NOT EXISTS`, so an older `usage_events` is left as it
       * is). The v1 statement already carries the column for every database
       * this module ever created, which is why the `ALTER` is skipped there:
       * without the check it would fail with "duplicate column name".
       */
      (driver) => {
        const columns = driver.prepare("PRAGMA table_info(usage_events)").all()
        const present = columns.some((row) => String(row.name) === "tags_json")
        if (!present) driver.exec("ALTER TABLE usage_events ADD COLUMN tags_json TEXT NOT NULL DEFAULT '{}'")
      },
      /**
       * Per-tag cost totals for folded days, for the `usage summary` breakdown.
       *
       * `usage_daily_rollups` cannot carry tags (one row per day/app/source/
       * provider/model), and `rollup()` deletes the detail rows it folded in the
       * same transaction — so without this table a day would silently drop out
       * of the tag breakdown while `summary()` still counted it. That is the
       * exact "healthy-looking silence" G74/G77 fixed for pricing, so the tag
       * dimension gets its own rollup table rather than an unmeasured gap.
       *
       * The key and value are stored as **text**, matching what
       * `usage_events.tags_json` held: values were sanitised and redacted before
       * they were ever stored (EVO-G75), so this is not a second exposure.
       */
      `CREATE TABLE IF NOT EXISTS usage_tag_rollups (
        date TEXT NOT NULL,
        app_id TEXT NOT NULL,
        tag_key TEXT NOT NULL,
        tag_value TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        cost_microusd INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, app_id, tag_key, tag_value)
      )`,
    ],
  },
]

export function migrate(driver: SqlDriver): number {
  driver.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)

  const applied = new Set<number>()
  for (const row of driver.prepare("SELECT version FROM schema_migrations").all()) {
    const version = Number(row.version)
    if (Number.isFinite(version)) applied.add(version)
  }

  let latest = 0
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      latest = Math.max(latest, migration.version)
      continue
    }
    driver.exec("BEGIN")
    try {
      for (const statement of migration.statements) {
        if (typeof statement === "string") driver.exec(statement)
        else statement(driver)
      }
      // `OR IGNORE`: two processes cold-starting the same new database can both
      // see an empty `schema_migrations` and race on this primary key. Losing the
      // race must not roll the migration back.
      driver.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, Date.now())
      driver.exec("COMMIT")
    } catch (error) {
      driver.exec("ROLLBACK")
      throw error
    }
    latest = Math.max(latest, migration.version)
  }
  return latest
}
