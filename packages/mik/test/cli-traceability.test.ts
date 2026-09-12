import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { USAGE_CSV_COLUMNS } from "../src/cli/csv.js"
import { main } from "../src/cli/index.js"
import { Store } from "../src/store/database.js"
import type { UsageEvent } from "../src/types.js"

/**
 * EVO-G86 — a **terminal-only** user has to be able to go from one `usage
 * export` row to the one `usage logs` record it came from.
 *
 * EVO-G81 put the identity into the file (`request_id`, column 16 — the same
 * value as `UsageEvent.requestId` and `GET /api/usage/logs/:id`), but the CLI
 * table never printed it, and `mik serve` is not something a CLI-first user
 * runs. The remaining alignment path was the HTTP route, i.e. a service the
 * user does not have.
 *
 * This card adds the id to the table behind the **opt-in** `--with-id` flag, so
 * the default table stays byte-for-byte what it was — the same trade EVO-G75
 * made for `usage summary --by-tag` (`usage.ts:486`).
 *
 * Why the flag cannot be replaced by the millisecond composite key
 * (`TS/app/provider/model/status`): A2 below seeds two calls with an
 * **identical** composite key and shows the key collapses them into one.
 *
 * Expectations in this file are **external literals** (the ids we seeded, the
 * rendered numbers we hand-wrote): never a value read back through the object
 * under test (R231).
 */

const SAME_MS = Date.parse("2026-09-12T04:00:00.000Z")

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g86-"))
  tempDirs.push(dir)
  return dir
}

interface Captured {
  code: number
  stdout: string
  stderr: string
}

/** Run the CLI in-process, offline, with `MIK_LANG=en` unless overridden. */
async function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, {
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    cwd,
    env: { ...process.env, MIK_LANG: "en", ...env },
    interactive: false,
  })
  return { code, stdout: out.join("\n"), stderr: err.join("\n") }
}

/** Keep the run off the network and on one database (see the G81 test). */
function cliBase(dir: string, db: string): string[] {
  return [
    "--offline",
    "--db",
    db,
    "--app",
    "g86-app",
    "--cache-dir",
    join(dir, "cache"),
    "--config",
    join(dir, "mik.config.json"),
  ]
}

/** Seed one `usage_events` row through the store, bypassing the hub on purpose. */
function seed(store: Store, overrides: Partial<UsageEvent> = {}): void {
  const event: UsageEvent = {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "g86-app",
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "seed",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    pricingModel: overrides.pricingModel,
    usage: overrides.usage ?? { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: overrides.cost ?? { usd: 0.005, low: 0.005, high: 0.005, basis: "flat", source: "modelsdev" },
    latencyMs: overrides.latencyMs ?? 120,
    firstTokenMs: overrides.firstTokenMs,
    status: overrides.status ?? "ok",
    errorCode: overrides.errorCode,
    isStreaming: overrides.isStreaming ?? false,
    sessionId: overrides.sessionId,
    tags: overrides.tags ?? {},
  }
  store.usage.insert(event)
}

/**
 * The data rows of a rendered `formatTable`, as trimmed cells.
 *
 * `formatTable` pads each cell to the column width and joins with two spaces
 * (`format.ts:111-115`), and none of this table's cells contains two
 * consecutive spaces, so the split is exact. The header is located by its
 * first cell (the run helper pins `MIK_LANG=en`), and the rows are the lines
 * after the dashed separator.
 */
function tableRows(stdout: string): string[][] {
  const lines = stdout.split("\n")
  const headerIndex = lines.findIndex((line) => line.trim().split(/\s{2,}/)[0] === "TS")
  if (headerIndex < 0) return []
  const rows: string[][] = []
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (line.trim() === "") break
    rows.push(line.trim().split(/\s{2,}/).map((cell) => cell.trim()))
  }
  return rows
}

/** The CSV data rows of `usage export` stdout, keyed by the shipped header. */
function csvRecords(stdout: string): Array<Record<string, string>> {
  const lines = stdout.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
  const names = USAGE_CSV_COLUMNS
  return lines.slice(1).map((line) => {
    const cells = line.split(",")
    return Object.fromEntries(names.map((name, index) => [name, cells[index] ?? ""]))
  })
}

describe("EVO-G86 A1 — a CSV row's request_id locates the same log record", () => {
  it("matches both sides on the id, and on every shared column", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "trace-alpha", ts: SAME_MS })
    seed(store, {
      requestId: "trace-beta",
      ts: SAME_MS + 1000,
      modelActual: "deepseek-reasoner",
      status: "error",
      errorCode: "rate_limit",
    })
    store.close()

    const exported = await run(["usage", "export", ...cliBase(dir, db)], dir)
    expect(exported.code).toBe(0)
    const records = csvRecords(exported.stdout)
    // External literals: the ids this test seeded, and the order `usageCsv`
    // sorts by (oldest first).
    expect(records.map((record) => record.request_id)).toEqual(["trace-alpha", "trace-beta"])
    const csv = records[0]!

    const logs = await run(["usage", "logs", "--with-id", ...cliBase(dir, db)], dir)
    expect(logs.code).toBe(0)
    const found = tableRows(logs.stdout).filter((row) => row.includes("trace-alpha"))
    expect(found).toHaveLength(1)
    const cli = found[0]!

    // The shared columns agree, hand-written on the CLI side. The last cell is
    // the id that did the matching.
    expect(cli.slice(1)).toEqual([
      "g86-app",
      "deepseek",
      "deepseek-chat",
      "ok",
      "1,000",
      "200",
      "0.0050",
      "modelsdev",
      "120 ms",
      "trace-alpha",
    ])
    // Same instant, checked across the two renders (the CSV writes UTC ISO, the
    // table writes local time): this is the "same record" claim, not just the
    // same id string.
    expect(new Date(`${cli[0]!.replace(" ", "T")}`).getTime()).toBe(Date.parse(csv.ts!))
    // And the id is what the other side carries.
    expect(cli.at(-1)).toBe(csv.request_id)
  })
})

describe("EVO-G86 A2 — the millisecond composite key is not unique", () => {
  it("two calls in the same millisecond differ only by the id", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "same-ms-1", ts: SAME_MS })
    seed(store, { requestId: "same-ms-2", ts: SAME_MS })
    store.close()

    const logs = await run(["usage", "logs", "--with-id", ...cliBase(dir, db)], dir)
    expect(logs.code).toBe(0)
    const rows = tableRows(logs.stdout)
    expect(rows).toHaveLength(2)
    // Every column the pre-G86 table printed is identical between the two rows:
    // the composite key collapses them into one record.
    expect(new Set(rows.map((row) => row.slice(0, 10).join("|"))).size).toBe(1)
    // The id is the only thing that separates them.
    expect(rows.map((row) => row.at(-1)).sort()).toEqual(["same-ms-1", "same-ms-2"])
  })
})

describe("EVO-G86 — the default table is unchanged", () => {
  it("prints no id unless --with-id is passed", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "trace-alpha", ts: SAME_MS })
    store.close()

    const plain = await run(["usage", "logs", ...cliBase(dir, db)], dir)
    expect(plain.code).toBe(0)
    const plainRows = tableRows(plain.stdout)
    expect(plainRows).toHaveLength(1)
    expect(plainRows[0]).toHaveLength(10)
    // The expected value is the literal id this test seeded: it is absent from
    // the default output (the pre-G86 behaviour this card preserves).
    expect(plain.stdout).not.toContain("trace-alpha")

    const withId = await run(["usage", "logs", "--with-id", ...cliBase(dir, db)], dir)
    expect(withId.code).toBe(0)
    const idRows = tableRows(withId.stdout)
    expect(idRows).toHaveLength(1)
    expect(idRows[0]).toHaveLength(11)
    expect(idRows[0]!.at(-1)).toBe("trace-alpha")
    // Same record, more columns: the ten pre-existing cells are unchanged.
    expect(idRows[0]!.slice(0, 10)).toEqual(plainRows[0])
  })

  it("keeps the id correct when --limit truncates the page", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "newest-1", ts: SAME_MS + 2000 })
    seed(store, { requestId: "older-1", ts: SAME_MS })
    store.close()

    const logs = await run(["usage", "logs", "--with-id", "--limit", "1", ...cliBase(dir, db)], dir)
    expect(logs.code).toBe(0)
    const rows = tableRows(logs.stdout)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.at(-1)).toBe("newest-1")
    expect(logs.stdout).toContain("Showing 1 of 2 event(s)")
  })

  it("prints nothing extra on an empty database", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    store.close()

    const plain = await run(["usage", "logs", ...cliBase(dir, db)], dir)
    const withId = await run(["usage", "logs", "--with-id", ...cliBase(dir, db)], dir)
    expect(withId.code).toBe(0)
    expect(withId.stdout).toBe(plain.stdout)
    // No phantom id column on an empty page: the flag changes nothing here.
    expect(withId.stdout).not.toContain("REQUEST ID")
  })

  it("prints the localized header in zh, with the same id", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const store = await Store.open({ path: db })
    seed(store, { requestId: "trace-alpha", ts: SAME_MS })
    store.close()

    const zh = await run(["usage", "logs", "--with-id", ...cliBase(dir, db)], dir, { MIK_LANG: "zh" })
    expect(zh.code).toBe(0)
    // Literal, not read back from the dictionary: the user-visible cell.
    expect(zh.stdout).toContain("请求 ID")
    expect(zh.stdout).toContain("trace-alpha")
  })
})
