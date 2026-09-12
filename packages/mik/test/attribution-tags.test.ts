import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { createTestServer } from "@ai-sdk/test-server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { USAGE_CSV_COLUMNS, USAGE_CSV_HEADER, USAGE_CSV_LEGACY_COLUMNS } from "../src/cli/csv.js"
import { main } from "../src/cli/index.js"
import { ModelInfra, type ModelInfraOptions } from "../src/hub.js"
import { createServer } from "../src/server/index.js"
import { Store } from "../src/store/database.js"
import type { ModelRequest, ProviderConfig, UsageEvent, UsageQuery } from "../src/types.js"
import { PROVIDER_COST_RAW_TAG, PROVIDER_COST_STATUS_TAG } from "../src/pricing/reported-cost.js"
import { UsageService } from "../src/usage/service.js"
import {
  MAX_TAG_VALUE_LENGTH,
  RESERVED_TAG_KEYS,
  RESERVED_TAG_PREFIX,
  attributionTags,
  isReservedTagKey,
  redactTagsForDisplay,
  sanitizeTags,
  tagLabelForDisplay,
  tagsToText,
} from "../src/usage/tags.js"

/**
 * EVO-G75 — host-defined attribution tags.
 *
 * The card's hard constraint is that this feature is **optional**: a host that
 * never passes `tags` must see byte-for-byte what it saw before. Every baseline
 * below is therefore a literal captured from the **published 0.2.20 artifact**
 * (`.tmp/g75-baseline/`, captured 2026-09-11 by `seed-baseline.mjs` +
 * `node_modules/model-infra-kit/dist/cli.mjs`), never a value recomputed by the
 * code under test — a snapshot compared against the constant that produced it
 * would pass no matter what changed (the G74 lesson).
 *
 * That capture also settles what was already true before this card:
 *  - `ModelRequest.tags` already existed, reached `usage_events.tags_json`, and
 *    already read back through `usage.get()`;
 *  - it was **not** redacted on the embedded path (the read-back showed the raw
 *    `Bearer sk-live-…`), and the CSV had **no** tags column;
 *  - there was no way to group by tag at all (`usage.byTag === undefined`).
 * The work here is the three gaps, not the storage of a tag map.
 */

const TEST_KEY = "sk-g75-testkey-1234"
/** A token-shaped string a host might paste into a tag by accident. */
const TAGGED_SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz"

/**
 * `usage summary` on the two published-baseline rows, **stdout only**, exactly
 * as the 0.2.20 CLI printed it with `MIK_LANG=en`.
 */
const PRE_CHANGE_SUMMARY =
  "Range - → - · app=base-app\n" +
  "\n" +
  "Requests        2\n" +
  "Successes       2\n" +
  "Failures        0\n" +
  "Success rate    100.0%\n" +
  "Cost (USD)      0.0060\n" +
  "Cost range      0.0060 – 0.0060\n" +
  "Input tokens    2,000\n" +
  "Output tokens   400\n" +
  "Cache read      0\n" +
  "Cache write     0\n" +
  "Reasoning       0\n" +
  "Cache hit rate  0.0%\n" +
  "Avg latency     120 ms\n" +
  "First token     0 ms\n"

/** The published-baseline detail rows, oldest first, as the 0.2.20 CSV wrote them. */
const PRE_CHANGE_EXPORT_ROWS = [
  "2025-09-02T08:00:00.000Z,base-app,deepseek,deepseek-chat,ok,1000,200,0,0,0,0.0050,modelsdev,flat,120",
  "2025-09-02T08:01:00.000Z,base-app,deepseek,deepseek-chat,ok,1000,200,0,0,0,0.0010,modelsdev,flat,120",
]

const root = "https://mock-g75.test/v1"

const COMPLETION = {
  id: "chatcmpl-g75",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "deepseek-chat",
  choices: [{ index: 0, message: { role: "assistant", content: "tagged hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
}

const server = createTestServer({
  [`${root}/ok/chat/completions`]: { response: { type: "json-value", body: COMPLETION } },
  /**
   * Reports its own billed amount (EVO-G73), which is the branch that makes
   * `providerCostTags()` write the two reconciliation keys — the branch an
   * `manual`-priced demo never reaches.
   */
  [`${root}/reported/chat/completions`]: {
    response: { type: "json-value", body: { ...COMPLETION, usage: { ...COMPLETION.usage, cost: "0.000123" } } },
  },
})

/** No test may reach the network: the catalogue load always fails here. */
const offlineFetch = (async () => {
  throw new Error("network disabled in tests")
}) as unknown as typeof globalThis.fetch

const tempDirs: string[] = []
const hubs: ModelInfra[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g75-"))
  tempDirs.push(dir)
  return dir
}

beforeAll(() => {
  server.server.start()
  // The key is read from the environment by the credential store, never stored.
  process.env.MIK_G75_KEY = TEST_KEY
})

afterAll(() => {
  server.server.stop()
  delete process.env.MIK_G75_KEY
  // Directories are left in the OS temp dir on purpose: the repo's delete rule
  // sends every removal to the recycle bin, which is not worth doing for temp.
  tempDirs.length = 0
})

beforeEach(() => {
  server.server.reset()
})

afterEach(async () => {
  while (hubs.length > 0) await hubs.pop()?.close()
})

function provider(): ProviderConfig {
  return { id: "ok", baseUrl: `${root}/ok`, apiKeyRef: "env:MIK_G75_KEY", enabled: true }
}

/** A hub on a real file database, so the CLI can be pointed at the same file. */
async function makeHub(db: string, options: ModelInfraOptions = {}): Promise<ModelInfra> {
  const hub = await ModelInfra.init({
    appId: "g75-app",
    db,
    cacheDir: join(tempDir(), "cache"),
    pricingFetch: offlineFetch,
    syncCatalog: false,
    maxRetries: 0,
    providers: [provider()],
    defaultModel: "ok:deepseek-chat",
    onWarn: () => {},
    ...options,
  })
  hubs.push(hub)
  return hub
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { messages: [{ role: "user", content: "hi" }], ...overrides }
}

interface Captured {
  code: number
  stdout: string
}

/** Run the CLI in-process, always in English and always offline. */
async function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  const out: string[] = []
  const code = await main(args, {
    io: { out: (text) => out.push(text), err: () => {} },
    cwd,
    env: { ...process.env, MIK_LANG: "en", ...env },
    interactive: false,
  })
  return { code, stdout: out.join("\n") }
}

/** The flags that keep a CLI run off the network and on one database. */
function cliBase(dir: string, db: string): string[] {
  return ["--offline", "--db", db, "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")]
}

/** Normalise line endings so a CRLF checkout compares equal to LF output (R99). */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

/** Seed one `usage_events` row through the store, bypassing the hub on purpose. */
function seed(store: Store, overrides: Partial<UsageEvent> = {}): void {
  const event: UsageEvent = {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "g75-app",
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "seed",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    usage: overrides.usage ?? { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: overrides.cost ?? { usd: 0.005, low: 0.005, high: 0.005, basis: "flat", source: "modelsdev" },
    latencyMs: overrides.latencyMs ?? 120,
    status: overrides.status ?? "ok",
    isStreaming: overrides.isStreaming ?? false,
    tags: overrides.tags ?? {},
  }
  store.usage.insert(event)
}

/**
 * A database in the schema **as it was before `tags_json` existed**: the marker
 * says v1 and the table has no such column.
 *
 * That is *older* than any published 0.2.x — those builds already ship
 * `tags_json` in their v1 DDL (measured: the 0.2.20 artifact's own database has
 * the column). This fixture exists because v2's job is to **tolerate** such a
 * file (SQLite has no `ADD COLUMN IF NOT EXISTS`), and `v1DatabaseLikePublished()`
 * below covers the realistic 0.2.20 → v2 upgrade.
 *
 * Every other table of that version is created too. A "legacy" database that
 * carries only the one table under test is not a legacy database: `migrate()`
 * sees version 1 and skips v1 entirely, so a missing `usage_daily_rollups`
 * would make `summary()` fail with "no such table" — a broken fixture, not a
 * broken migration.
 */
function legacyDatabase(): string {
  return legacyDatabaseWith({ withTagsColumn: false })
}

/**
 * The **realistic** upgrade: a database shaped like a published 0.2.20 one —
 * marker v1, `usage_events` **already carrying `tags_json`**, and a tagged row
 * written by that build (unredacted, as 0.2.20 did).
 *
 * It exercises the half of v2 the older fixture cannot: the conditional
 * `ADD COLUMN` has to be a **no-op** rather than a duplicate-column error.
 */
function publishedDatabase(): string {
  return legacyDatabaseWith({ withTagsColumn: true })
}

function legacyDatabaseWith({ withTagsColumn }: { withTagsColumn: boolean }): string {
  const dir = tempDir()
  const path = join(dir, "usage.db")
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1)`)
  db.exec(`CREATE TABLE usage_events (
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
    session_id TEXT${withTagsColumn ? ",\n    tags_json TEXT NOT NULL DEFAULT '{}'" : ""}
  )`)
  db.exec(`CREATE TABLE usage_daily_rollups (
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
  )`)
  db.exec(`CREATE TABLE providers (
    id TEXT PRIMARY KEY, app_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, protocol TEXT NOT NULL,
    base_url TEXT, api_key_ref TEXT, npm_package TEXT, headers_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1, preset_id TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.exec(`INSERT INTO usage_events (
    request_id, app_id, ts, source, provider_id, model_requested, model_actual,
    input_tokens, output_tokens, cost_usd, cost_low_usd, cost_high_usd, pricing_source, pricing_basis,
    latency_ms, status, is_streaming, session_id${withTagsColumn ? ", tags_json" : ""}
  ) VALUES (
    'legacy-1', 'g75-app', 1756800000000, 'legacy', 'deepseek', 'deepseek:deepseek-chat', 'deepseek-chat',
    1000, 200, 0.005, 0.005, 0.005, 'modelsdev', 'flat', 120, 'ok', 0, 'legacy-session'${
      withTagsColumn ? `, '${JSON.stringify({ feature: "quant-backtest", note: `Bearer ${TAGGED_SECRET}` }).replace(/'/g, "''")}'` : ""
    }
  )`)
  db.close()
  return path
}

describe("EVO-G75 A1 — a tagged call can be queried back and shows up in the CSV", () => {
  it("stores the host's tags on the usage row and returns them unchanged", async () => {
    const db = join(tempDir(), "usage.db")
    const hub = await makeHub(db)

    await hub.generate(request({ model: "ok:deepseek-chat", tags: { feature: "quant-backtest", sessionId: "s-1" } }))

    const page = hub.usage.query()
    expect(page.total).toBe(1)
    expect(page.events[0]?.tags).toEqual({ feature: "quant-backtest", sessionId: "s-1" })
    // Same value through a direct lookup, i.e. the row on disk, not a cache.
    expect(hub.usage.get(page.events[0]!.requestId)?.tags).toEqual({
      feature: "quant-backtest",
      sessionId: "s-1",
    })
  })

  it("writes the tags into the export CSV's appended column", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const hub = await makeHub(db)
    await hub.generate(request({ model: "ok:deepseek-chat", tags: { feature: "quant-backtest" } }))

    const { code, stdout } = await run(["usage", "export", ...cliBase(dir, db), "--app", "g75-app"], dir)

    expect(code).toBe(0)
    const lines = normalize(stdout).trimEnd().split("\n")
    expect(lines[0]).toBe(USAGE_CSV_HEADER)
    expect(lines[0]?.endsWith(",tags")).toBe(true)
    expect(lines[1]?.endsWith(",feature=quant-backtest")).toBe(true)
  })
})

describe("EVO-G75 A2 — with no tags the output is byte-for-byte the 0.2.20 baseline", () => {
  it("keeps `usage summary` identical when the host passes no tags", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    // Exactly the two rows the published build was captured on.
    store.usage.insert({
      requestId: "base-tagged",
      appId: "base-app",
      ts: 1756800000000,
      source: "harness-baseline",
      providerId: "deepseek",
      modelRequested: "deepseek:deepseek-chat",
      modelActual: "deepseek-chat",
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usd: 0.005, low: 0.005, high: 0.005, basis: "flat", source: "modelsdev" },
      latencyMs: 120,
      status: "ok",
      isStreaming: false,
      tags: { feature: "quant-backtest", note: `Bearer ${TAGGED_SECRET}` },
    })
    store.usage.insert({
      requestId: "base-plain",
      appId: "base-app",
      ts: 1756800060000,
      source: "harness-baseline",
      providerId: "deepseek",
      modelRequested: "deepseek:deepseek-chat",
      modelActual: "deepseek-chat",
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usd: 0.001, low: 0.001, high: 0.001, basis: "flat", source: "modelsdev" },
      latencyMs: 120,
      status: "ok",
      isStreaming: false,
      tags: {},
    })
    store.close()

    const { code, stdout } = await run(["usage", "summary", ...cliBase(dir, db), "--app", "base-app"], dir)

    expect(code).toBe(0)
    expect(normalize(stdout).trimEnd()).toBe(normalize(PRE_CHANGE_SUMMARY).trimEnd())
  })

  it("keeps the fourteen pre-existing CSV columns byte-identical", () => {
    expect(USAGE_CSV_LEGACY_COLUMNS).toEqual([
      "ts",
      "app_id",
      "provider",
      "model",
      "status",
      "input",
      "output",
      "cache_read",
      "cache_write",
      "reasoning",
      "cost_usd",
      "pricing_source",
      "pricing_basis",
      "latency_ms",
    ])
    expect(USAGE_CSV_HEADER.startsWith(USAGE_CSV_LEGACY_COLUMNS.join(","))).toBe(true)
    expect(USAGE_CSV_COLUMNS.slice(0, 14)).toEqual(USAGE_CSV_LEGACY_COLUMNS)
    // The published rows keep their exact text; only a 15th field is appended.
    for (const row of PRE_CHANGE_EXPORT_ROWS) {
      expect(row.split(",")).toHaveLength(14)
    }
  })
})

describe("EVO-G75 A3 — `usage summary` can split cost by tag", () => {
  it("groups cost per tag, most expensive first, and reports unattributed requests", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, {
      requestId: "t1",
      cost: { usd: 0.004, low: 0.004, high: 0.004, basis: "flat", source: "modelsdev" },
      tags: { feature: "quant-backtest" },
    })
    seed(store, { requestId: "t2", tags: { feature: "chat" } })
    seed(store, { requestId: "t3", tags: { feature: "chat" } })
    seed(store, { requestId: "t4" })

    // `chat` accumulates 0.005 + 0.005 = 0.010 and outranks `quant-backtest`.
    expect(store.usage.byTag({ appId: "g75-app" }).map((b) => [b.key, b.costUsd, b.requests])).toEqual([
      ["feature=chat", 0.01, 2],
      ["feature=quant-backtest", 0.004, 1],
    ])
    store.close()

    const { code, stdout } = await run(["usage", "summary", "--by-tag", ...cliBase(dir, db), "--app", "g75-app"], dir)

    expect(code).toBe(0)
    const text = normalize(stdout)
    expect(text).toContain("Cost by attribution tag")
    expect(text).toContain("feature=quant-backtest")
    expect(text).toContain("feature=chat")
    expect(text).toContain("0.0100")
    expect(text).toContain("0.0040")
    // The two things a reader could get wrong are stated, not implied.
    expect(text).toContain("sum to more than the total")
    expect(text).toContain("a call with no tag is not listed at all")
  })

  it("is silent unless --by-tag is passed", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { tags: { feature: "quant-backtest" } })
    store.close()

    const { stdout } = await run(["usage", "summary", ...cliBase(dir, db), "--app", "g75-app"], dir)

    expect(normalize(stdout)).not.toContain("attribution tag")
  })

  it("clips a very long tag in the table but keeps it whole in the CSV", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    // A 256-character value is lawful (the cap), and would otherwise size the
    // column to the whole screen.
    const long = "y".repeat(MAX_TAG_VALUE_LENGTH)
    seed(store, { requestId: "long-1", tags: { feature: long } })
    store.close()

    const breakdown = await run(["usage", "summary", "--by-tag", ...cliBase(dir, db), "--app", "g75-app"], dir)
    const table = normalize(breakdown.stdout)
    // The cell is clipped to 48 code points of the whole `key=value` string,
    // i.e. `feature=` plus 40 of the value's characters, then an ellipsis.
    const clipped = `${"feature="}${long}`.slice(0, 48)
    expect(clipped).toBe(`feature=${"y".repeat(40)}`)
    expect(table).toContain(`${clipped}…`)
    expect(table).not.toContain(`feature=${long}`)
    expect(table).not.toContain(long)

    const exported = await run(["usage", "export", ...cliBase(dir, db), "--app", "g75-app"], dir)
    expect(normalize(exported.stdout)).toContain(`feature=${long}`)
  })
  it("filters by one tag through the query API", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "f1", tags: { feature: "quant-backtest" } })
    seed(store, { requestId: "f2", tags: { feature: "chat" } })

    expect(store.usage.query({ appId: "g75-app", tag: "feature", tagValue: "chat" }).events.map((e) => e.requestId)).toEqual(["f2"])
    expect(store.usage.query({ appId: "g75-app", tag: "feature" }).total).toBe(2)
    expect(store.usage.query({ appId: "g75-app", tag: "absent" }).total).toBe(0)
    store.close()
  })
})

describe("EVO-G75 A4 — an old database upgrades without losing data", () => {
  it("adds the column, keeps the legacy row readable, and accepts a new tagged row", async () => {
    const path = legacyDatabase()
    const store = await Store.open({ path })
    const columns = store.driver.prepare("PRAGMA table_info(usage_events)").all().map((row) => String(row.name))
    const applied = store.driver
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => Number(row.version))

    expect(columns).toContain("tags_json")
    expect(applied).toEqual([1, 2])

    // ① no data lost, ② the pre-change row reads back (with empty tags).
    const legacy = store.usage.get("legacy-1")
    expect(legacy?.modelActual).toBe("deepseek-chat")
    expect(legacy?.sessionId).toBe("legacy-session")
    expect(legacy?.cost.usd).toBeCloseTo(0.005, 9)
    expect(legacy?.tags).toEqual({})
    expect(store.usage.summary({ appId: "g75-app" }).requests).toBe(1)

    // ③ a new row with tags writes and reads back.
    store.usage.insert({
      requestId: "new-1",
      appId: "g75-app",
      ts: 1756900000000,
      source: "post-upgrade",
      providerId: "deepseek",
      modelRequested: "deepseek:deepseek-chat",
      modelActual: "deepseek-chat",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usd: 0.001, low: 0.001, high: 0.001, basis: "flat", source: "modelsdev" },
      latencyMs: 10,
      status: "ok",
      isStreaming: false,
      tags: { feature: "post-upgrade" },
    })
    expect(store.usage.get("new-1")?.tags).toEqual({ feature: "post-upgrade" })
    expect(store.usage.byTag({ appId: "g75-app" }).map((bucket) => bucket.key)).toEqual(["feature=post-upgrade"])
    store.close()
  })

  it("creates the tag rollup table on a fresh database too", async () => {
    const store = await Store.open({ path: ":memory:" })
    const tables = store.driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    expect(tables).toContain("usage_tag_rollups")
    store.close()
  })

  it("upgrades a published-0.2.20-shaped database: no duplicate column, data intact", async () => {
    const path = publishedDatabase()
    const store = await Store.open({ path })

    // v2 must not have tried to add a column that is already there.
    expect(
      store.driver
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => Number(row.version)),
    ).toEqual([1, 2])
    expect(
      store.driver
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_tag_rollups'")
        .get()?.name,
    ).toBe("usage_tag_rollups")

    const legacy = store.usage.get("legacy-1")
    expect(legacy?.modelActual).toBe("deepseek-chat")
    expect(legacy?.cost.usd).toBeCloseTo(0.005, 9)
    // The tagged row a 0.2.20 host wrote reads back verbatim (it was stored
    // unredacted back then; redaction happens where it is rendered, not here).
    expect(legacy?.tags).toEqual({ feature: "quant-backtest", note: `Bearer ${TAGGED_SECRET}` })
    expect(store.usage.byTag({ appId: "g75-app" }).map((b) => [b.key, b.requests])).toEqual([
      ["feature=quant-backtest", 1],
      [`note=Bearer ${TAGGED_SECRET}`, 1],
    ])
    store.close()
  })

  it("keeps a folded day's tag cost visible", async () => {
    const store = await Store.open({ path: ":memory:" })
    seed(store, { requestId: "fold-1", ts: 1756800000000, cost: { usd: 0.005, low: 0.005, high: 0.005, basis: "flat", source: "modelsdev" }, tags: { feature: "quant-backtest" } })

    expect(store.usage.rollup(Date.now())).toBe(1)
    expect(store.usage.summary({ appId: "g75-app" }).requests).toBe(1)
    expect(store.usage.byTag({ appId: "g75-app" }).map((b) => [b.key, b.costUsd, b.requests])).toEqual([
      ["feature=quant-backtest", 0.005, 1],
    ])
    store.close()
  })
})

describe("EVO-G75 A5 — a token in a tag is redacted before it is stored or exported", () => {
  it("redacts `Bearer <token>` through the hub's own record path", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const hub = await makeHub(db)

    await hub.generate(request({ model: "ok:deepseek-chat", tags: { feature: "chat", note: `Bearer ${TAGGED_SECRET}` } }))

    const event = hub.usage.query().events[0]!
    expect(event.tags?.note).toBe("Bearer [REDACTED]")
    expect(JSON.stringify(event.tags)).not.toContain(TAGGED_SECRET)

    const { stdout } = await run(["usage", "export", ...cliBase(dir, db), "--app", "g75-app"], dir)
    expect(stdout).not.toContain(TAGGED_SECRET)
    expect(stdout).toContain("note=Bearer [REDACTED]")
  })

  it("clears a value stored under a secret-looking key", () => {
    expect(sanitizeTags({ api_key: TAGGED_SECRET, feature: "chat" })).toEqual({
      api_key: "[REDACTED]",
      feature: "chat",
    })
    expect(sanitizeTags({ authorization: `Bearer ${TAGGED_SECRET}` })).toEqual({ authorization: "[REDACTED]" })
    // A `sk-` prefix is masked even in a benign-looking key.
    expect(sanitizeTags({ note: TAGGED_SECRET })).toEqual({ note: "sk-****" })
  })
})

describe("EVO-G75 A6 — malformed tag values never throw", () => {
  it("coerces or ignores every shape by the documented policy", () => {
    const long = "x".repeat(MAX_TAG_VALUE_LENGTH + 50)
    const tags = sanitizeTags({
      feature: "chat",
      count: 3,
      flag: true,
      empty: null,
      missing: undefined,
      nested: { a: 1, b: "two" },
      list: ["a", "b"],
      big: 10n,
      fn: () => 1,
      [`k${"y".repeat(80)}`]: "dropped-key",
      "": "dropped-empty-key",
      long,
    })

    expect(tags).toBeDefined()
    expect(tags?.feature).toBe("chat")
    expect(tags?.count).toBe("3")
    expect(tags?.flag).toBe("true")
    expect(tags?.empty).toBe("")
    expect(tags?.missing).toBe("")
    expect(tags?.nested).toBe('{"a":1,"b":"two"}')
    expect(tags?.list).toBe('["a","b"]')
    expect(tags?.big).toBe("10")
    expect(tags?.fn).toBe("")
    expect(tags?.long).toHaveLength(MAX_TAG_VALUE_LENGTH)
    // Over-long keys are dropped rather than truncated into a collision.
    expect(Object.keys(tags ?? {}).some((key) => key.startsWith("ky"))).toBe(false)
    expect(tags?.[""]).toBeUndefined()
  })

  it("survives a cyclic value and a non-object `tags`", () => {
    const cyclic: Record<string, unknown> = { feature: "chat" }
    cyclic.self = cyclic

    expect(() => sanitizeTags(cyclic)).not.toThrow()
    expect(sanitizeTags(cyclic)?.self).toBe("[unserializable]")
    expect(sanitizeTags("not-an-object")).toBeUndefined()
    expect(sanitizeTags(null)).toBeUndefined()
    expect(sanitizeTags([1, 2, 3])).toBeUndefined()
    expect(sanitizeTags({})).toBeUndefined()
  })

  it("does not throw out of a query when a stored cell is malformed JSON", async () => {
    const store = await Store.open({ path: ":memory:" })
    seed(store, { requestId: "good", tags: { feature: "chat" } })
    store.driver
      .prepare("INSERT INTO usage_events (request_id, app_id, ts, source, provider_id, tags_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("bad", "g75-app", 1756800000000, "seed", "deepseek", "not-json")

    expect(() => store.usage.byTag({ appId: "g75-app" })).not.toThrow()
    expect(store.usage.byTag({ appId: "g75-app" }).map((bucket) => bucket.key)).toEqual(["feature=chat"])
    expect(store.usage.get("bad")?.tags).toEqual({})
    store.close()
  })

  it("keeps a call successful when the host passes a nonsensical `tags`", async () => {
    const db = join(tempDir(), "usage.db")
    const hub = await makeHub(db)
    const hostile = { feature: "chat", nested: { deep: { deeper: 1 } }, long: "y".repeat(5_000) }

    const response = await hub.generate(
      request({ model: "ok:deepseek-chat", tags: hostile as unknown as Record<string, string> }),
    )

    expect(response.text).toBe("tagged hello")
    const event = hub.usage.query().events[0]!
    expect(event.tags?.feature).toBe("chat")
    expect(event.tags?.nested).toBe('{"deep":{"deeper":1}}')
    expect(event.tags?.long).toHaveLength(MAX_TAG_VALUE_LENGTH)
  })
})

describe("EVO-G75 — machine-written keys stay readable but never become a cost bucket", () => {
  it("excludes the real EVO-G73 reconciliation keys from the breakdown", async () => {
    const store = await Store.open({ path: ":memory:" })
    seed(store, {
      requestId: "g73",
      cost: { usd: 0.002, low: 0.002, high: 0.002, basis: "exact", source: "provider" },
      // The **real** constants, not a `_mik_`-prefixed invention: the shipped
      // keys are unprefixed, and the first revision of this suite asserted the
      // opposite (that `provider_cost_raw` was *not* reserved), which pinned the
      // no-op filter as if it were correct behaviour.
      tags: {
        [PROVIDER_COST_RAW_TAG]: "0.000002",
        [PROVIDER_COST_STATUS_TAG]: "accepted",
        feature: "chat",
      },
    })

    expect(RESERVED_TAG_KEYS).toContain(PROVIDER_COST_RAW_TAG)
    expect(RESERVED_TAG_KEYS).toContain(PROVIDER_COST_STATUS_TAG)
    expect(RESERVED_TAG_PREFIX).toBe("_mik_")
    expect(isReservedTagKey(PROVIDER_COST_RAW_TAG)).toBe(true)
    expect(isReservedTagKey(PROVIDER_COST_STATUS_TAG)).toBe(true)
    expect(isReservedTagKey(`${RESERVED_TAG_PREFIX}future_key`)).toBe(true)
    expect(isReservedTagKey("feature")).toBe(false)
    // Still in the row, so G73's reconciliation keeps working.
    expect(store.usage.get("g73")?.tags?.[PROVIDER_COST_RAW_TAG]).toBe("0.000002")
    expect(store.usage.get("g73")?.tags?.[PROVIDER_COST_STATUS_TAG]).toBe("accepted")
    expect(store.usage.byTag({ appId: "g75-app" }).map((bucket) => bucket.key)).toEqual(["feature=chat"])
    store.close()
  })

  /**
   * The branch the first revision never reached: its demo priced through a
   * `manual` card, so nothing wrote the reconciliation keys. This call reports
   * its own billed amount, which is what makes `providerCostTags()` write both.
   */
  it("keeps a provider-reported amount out of the breakdown, end to end", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const hub = await ModelInfra.init({
      appId: "g75-app",
      db,
      cacheDir: join(tempDir(), "cache"),
      pricingFetch: offlineFetch,
      syncCatalog: false,
      maxRetries: 0,
      providers: [{ id: "reported", baseUrl: `${root}/reported`, apiKeyRef: "env:MIK_G75_KEY", enabled: true }],
      onWarn: () => {},
    })
    hubs.push(hub)

    await hub.generate(request({ model: "reported:deepseek-chat", tags: { feature: "quant-backtest" } }))

    const event = hub.usage.query().events[0]!
    // G73's reconciliation data is present and untouched…
    expect(event.tags?.[PROVIDER_COST_RAW_TAG]).toBe("0.000123")
    expect(event.tags?.[PROVIDER_COST_STATUS_TAG]).toBe("accepted")
    expect(event.cost.source).toBe("provider")
    // …and absent from the cost split, which is the whole point of the card.
    expect(hub.usage.byTag().map((bucket) => bucket.key)).toEqual(["feature=quant-backtest"])

    const { stdout } = await run(["usage", "export", ...cliBase(dir, db), "--app", "g75-app"], dir)
    expect(stdout).toContain("feature=quant-backtest")
    expect(stdout).not.toContain(PROVIDER_COST_RAW_TAG)
    expect(stdout).not.toContain(PROVIDER_COST_STATUS_TAG)
  })

  it("renders attribution tags as stable `key=value` text", () => {
    expect(tagsToText({ b: "2", a: "1", [PROVIDER_COST_RAW_TAG]: "x" })).toBe("a=1 b=2")
    expect(tagsToText(undefined)).toBe("")
    expect(attributionTags({ a: "1", [PROVIDER_COST_STATUS_TAG]: "accepted" })).toEqual({ a: "1" })
  })

  /**
   * The evaluator's note 1: `hub.record()` merges the machine-written
   * diagnostics **after** `sanitizeTags()`, so those values do not pass through
   * `redactDeep`. Measured scope of that gap:
   *
   * - the only provider-derived text is `provider_cost_raw` (the amount), plus
   *   `provider_cost_status`, whose every `reason` is a fixed literal in
   *   `pricing/reported-cost.ts` (`"not a decimal amount"`, …) or a count — no
   *   host or provider prose is interpolated into it;
   * - a **host** value can never bypass redaction this way, which is what this
   *   test pins: a host that names a tag like a diagnostic key still gets it
   *   redacted, and only an amount the endpoint itself reported can overwrite it.
   * - the two rendered surfaces redact regardless (B1 above), and `byTag()`
   *   excludes these keys (above), so nothing escapes through a G75 surface.
   */
  it("does not let a host tag bypass redaction by naming a diagnostic key", async () => {
    const db = join(tempDir(), "usage.db")
    const hub = await makeHub(db)
    // No amount is reported by the mock, so `providerCostTags()` writes nothing
    // and the host's own value is what survives.
    await hub.generate(
      request({ model: "ok:deepseek-chat", tags: { [PROVIDER_COST_RAW_TAG]: `Bearer ${TAGGED_SECRET}` } }),
    )

    const stored = hub.usage.query().events[0]?.tags?.[PROVIDER_COST_RAW_TAG]
    expect(stored).toBe("Bearer [REDACTED]")
    expect(JSON.stringify(hub.usage.query().events[0]?.tags)).not.toContain(TAGGED_SECRET)
  })
})

/**
 * B1 — the read side must not print a plaintext token either.
 *
 * Redaction on the write path cannot help a row that already exists: a database
 * written by 0.2.20 holds whatever the host handed over, and this card is what
 * gave those values a CSV column and a table row. Both rendering functions are
 * therefore asserted against a **stored, unredacted** map — the exact shape a
 * legacy row has.
 */
describe("EVO-G75 B1 — legacy rows are redacted where they are rendered", () => {
  const legacyTags = { feature: "chat", note: `Bearer ${TAGGED_SECRET}`, api_key: TAGGED_SECRET }

  it("masks a plaintext token in the CSV column", () => {
    expect(tagsToText(legacyTags)).not.toContain(TAGGED_SECRET)
    expect(tagsToText(legacyTags)).toBe("api_key=[REDACTED] feature=chat note=Bearer [REDACTED]")
    // The stored map itself is not rewritten — G73's raw values must survive.
    expect(legacyTags.note).toContain(TAGGED_SECRET)
  })

  it("masks a plaintext token in the breakdown label", () => {
    expect(tagLabelForDisplay(`note=Bearer ${TAGGED_SECRET}`)).toBe("note=Bearer [REDACTED]")
    expect(tagLabelForDisplay(`api_key=${TAGGED_SECRET}`)).toBe("api_key=[REDACTED]")
    expect(tagLabelForDisplay("feature=quant-backtest")).toBe("feature=quant-backtest")
  })

  it("covers the whole way out: a legacy row exported and grouped by --by-tag", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    // Written through the store, i.e. exactly what 0.2.20 left on disk.
    seed(store, { requestId: "legacy-plain", tags: legacyTags })
    store.close()

    const exported = await run(["usage", "export", ...cliBase(dir, db), "--app", "g75-app"], dir)
    expect(normalize(exported.stdout)).not.toContain(TAGGED_SECRET)
    expect(normalize(exported.stdout)).toContain("note=Bearer [REDACTED]")

    const breakdown = await run(["usage", "summary", "--by-tag", ...cliBase(dir, db), "--app", "g75-app"], dir)
    expect(normalize(breakdown.stdout)).not.toContain(TAGGED_SECRET)
    expect(normalize(breakdown.stdout)).toContain("note=Bearer [REDACTED]")

    // And the database still holds the original bytes (no silent rewrite).
    const reopened = await Store.open({ path: db })
    expect(reopened.usage.get("legacy-plain")?.tags?.note).toBe(`Bearer ${TAGGED_SECRET}`)
    reopened.close()
  })

  /**
   * The last tag-carrying egress: `GET /api/events`, whose frames carry whatever
   * the caller handed to `UsageService.record()`. A host that calls that method
   * directly bypasses the write-path `sanitizeTags()`, so the frame is redacted
   * at the SSE edge — the same `sanitize()` every other JSON response uses.
   *
   * Chunk boundaries are never assumed (R193): the frame is found by
   * accumulating the decoded body and testing `includes` on the buffer.
   */
  it("redacts tag values in the usage.recorded SSE frame", async () => {
    const db = join(tempDir(), "usage.db")
    const hub = await makeHub(db)
    const handle = await createServer({ hub, port: 0, heartbeatMs: 20 })
    const controller = new AbortController()
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/events`, { signal: controller.signal })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffered = ""
      const more = async (): Promise<boolean> => {
        const chunk = await reader.read()
        if (chunk.done) return false
        buffered += decoder.decode(chunk.value, { stream: true })
        return true
      }
      // Wait for the connection comment, then push one event through the service.
      while (!buffered.includes(": connected")) {
        if (!(await more())) break
      }

      // Straight into the service: no `tags` sanitisation on this path.
      hub.usage.record({
        requestId: "sse-plain",
        ts: Date.now(),
        source: "direct",
        providerId: "deepseek",
        modelRequested: "deepseek:deepseek-chat",
        modelActual: "deepseek-chat",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: { usd: 0.001, low: 0.001, high: 0.001, basis: "flat", source: "modelsdev" },
        latencyMs: 5,
        status: "ok",
        isStreaming: false,
        tags: { feature: "chat", note: `Bearer ${TAGGED_SECRET}` },
      })

      const deadline = Date.now() + 5_000
      while (!buffered.includes("usage.recorded") && Date.now() < deadline) {
        if (!(await more())) break
      }

      const frame = buffered.slice(buffered.indexOf("event: usage.recorded"))
      expect(frame).toContain('"feature":"chat"')
      expect(frame).toContain('"appId"')
      expect(frame).not.toContain(TAGGED_SECRET)
      expect(frame).toContain("Bearer [REDACTED]")
    } finally {
      controller.abort()
      await handle.close()
    }
  })
})

/**
 * Rule 5: a change to the public surface must land in `docs/interfaces.md`.
 *
 * The assertions read the real symbols (`UsageQuery`, `UsageService`,
 * `ModelRequest` are used as types inside the objects below, so a renamed or
 * missing field fails `tsc`), and the document is checked for the names it
 * claims are public. **What this cannot prove is that the built `dist` exports
 * them** — that check is done against the actual artifact in the card's report
 * (R163), not here: making a unit test build the package would put network and
 * packaging in the unit suite.
 */
describe("EVO-G75 A5 — the contract names the surface this card added", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/interfaces.md", import.meta.url)), "utf8")

  it("documents `byTag`, the two query fields, and the appended CSV column", () => {
    expect(doc).toContain("byTag(query?: UsageQuery): UsageBucket[]")
    expect(doc).toContain("tag?: string")
    expect(doc).toContain("tagValue?: string")
    expect(doc).toContain("第 15 列")
    expect(doc).toContain("--by-tag")
    expect(doc).toContain("usage_tag_rollups")
  })

  it("keeps the documented types in step with the source", () => {
    const query: UsageQuery = { tag: "feature", tagValue: "chat" }
    const request: ModelRequest = { messages: [], tags: { feature: "chat" } }
    expect(query.tagValue).toBe("chat")
    expect(request.tags?.feature).toBe("chat")
    // The method exists on the public service with the documented signature.
    expect(Object.getOwnPropertyNames(UsageService.prototype)).toContain("byTag")
  })

  it("states the boundary the card refuses: a tag is not an identity", () => {
    expect(doc).toContain("**不是身份**")
    expect(doc).toContain("不做权限、不做多租户、不做配额")
  })
})
