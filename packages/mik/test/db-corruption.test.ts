import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModelInfraError } from "../src/errors.js"
import { Store } from "../src/store/database.js"
import { nodeSqliteDriver, type SqlDriver } from "../src/store/driver.js"
import { quarantineDatabase } from "../src/store/trash.js"

/**
 * EVO-G06 / G11 — a corrupt ledger must not stop a host from booting, and the
 * damaged bytes must survive in `trash/db-corrupt-…` for a manual recovery.
 */

const stores: Store[] = []
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-db-corrupt-"))
  tempDirs.push(dir)
  return dir
}

/** Make a file read-only the way each platform spells it, and return a restore hook. */
function makeReadOnly(file: string): () => void {
  if (process.platform === "win32") {
    execFileSync("attrib", ["+R", file])
    return () => execFileSync("attrib", ["-R", file])
  }
  chmodSync(file, 0o444)
  return () => chmodSync(file, 0o644)
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

/** A migrated ledger with `count` usage rows, closed cleanly. */
async function seedDatabase(file: string, count: number): Promise<void> {
  const store = await Store.open({ path: file })
  for (let index = 0; index < count; index += 1) {
    store.driver
      .prepare(
        `INSERT INTO usage_events (request_id, app_id, ts, source, provider_id, status, cost_usd, cost_low_usd, cost_high_usd)
         VALUES (?, 'test-app', ?, 'embedded', 'deepseek', 'ok', 0, 0, 0)`,
      )
      .run(`req-${index}`, Date.now() + index)
  }
  store.close()
}

/** Count rows through a private read-only connection, bypassing the self-healing open. */
async function rowCount(file: string): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite")
  const driver = new DatabaseSync(file, { readOnly: true }) as unknown as SqlDriver
  try {
    return Number(driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get()?.n ?? 0)
  } finally {
    driver.close()
  }
}

/** Overwrite the SQLite header with bytes SQLite reads as "file is not a database". */
function corruptHeader(file: string): Buffer {
  const bytes = readFileSync(file)
  const damaged = Buffer.from(bytes)
  damaged.fill(0x00, 0, Math.min(100, damaged.length))
  writeFileSync(file, damaged)
  return damaged
}

function trashIncidentDirs(trashDir: string): string[] {
  if (!existsSync(trashDir)) return []
  return readdirSync(trashDir).filter((entry) => entry.startsWith("db-corrupt-"))
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe("Store database corruption self-heal (EVO-G06)", () => {
  it("quarantines a corrupt database, keeps its bytes and boots on an empty ledger", async () => {
    const root = tempDir()
    const file = join(root, "usage.db")
    const trashDir = join(root, "trash")
    await seedDatabase(file, 3)

    const beforeBytes = corruptHeader(file)

    const warnings: string[] = []
    const store = await Store.open({
      path: file,
      trashDir,
      onWarn: (message) => warnings.push(message),
    })
    stores.push(store)

    // A1: the host is up, on a brand-new schema, with an empty ledger.
    expect(store.schemaVersion).toBeGreaterThan(0)
    expect(store.usage.summary().requests).toBe(0)
    expect(await rowCount(file)).toBe(0)
    expect(existsSync(file)).toBe(true)

    // A1: the damaged bytes are preserved byte-for-byte, not deleted.
    const incidents = trashIncidentDirs(trashDir)
    expect(incidents).toHaveLength(1)
    const incidentDir = join(trashDir, incidents[0]!)
    const quarantined = join(incidentDir, "usage.db")
    expect(existsSync(quarantined)).toBe(true)
    const quarantinedBytes = readFileSync(quarantined)
    expect(quarantinedBytes.length).toBe(beforeBytes.length)
    expect(quarantinedBytes.equals(beforeBytes)).toBe(true)

    // A1: one loud warning, naming the full quarantine path and the recovery route.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(incidentDir)
    expect(warnings[0]).toMatch(/reset/i)
    expect(warnings[0]).toMatch(/sqlite3/i)
  })

  it("moves the database and its journal siblings into one incident directory", async () => {
    const root = tempDir()
    const file = join(root, "usage.db")
    await seedDatabase(file, 1)

    // Checked at the quarantine boundary rather than through `Store.open`: SQLite's
    // own recovery may already have discarded a bogus `-wal` before we get there.
    const walBytes = Buffer.from("stale wal bytes")
    const shmBytes = Buffer.from("stale shm bytes")
    writeFileSync(`${file}-wal`, walBytes)
    writeFileSync(`${file}-shm`, shmBytes)
    const dbBytes = readFileSync(file)

    const result = quarantineDatabase(file, { trashDir: join(root, "trash") })

    expect(readdirSync(result.dir).sort()).toEqual(["usage.db", "usage.db-shm", "usage.db-wal"])
    expect(readFileSync(join(result.dir, "usage.db")).equals(dbBytes)).toBe(true)
    expect(readFileSync(join(result.dir, "usage.db-wal")).equals(walBytes)).toBe(true)
    expect(readFileSync(join(result.dir, "usage.db-shm")).equals(shmBytes)).toBe(true)
    expect(result.files).toHaveLength(3)
    // Moved, not copied: the originals are gone from their old location.
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(`${file}-shm`)).toBe(false)
  })

  it("leaves a healthy database completely alone", async () => {
    const root = tempDir()
    const file = join(root, "usage.db")
    const trashDir = join(root, "trash")
    await seedDatabase(file, 4)

    const warnings: string[] = []
    const store = await Store.open({ path: file, trashDir, onWarn: (message) => warnings.push(message) })
    stores.push(store)

    // A2: no warning, no quarantine directory, rows untouched.
    expect(warnings).toEqual([])
    expect(trashIncidentDirs(trashDir)).toEqual([])
    expect(existsSync(trashDir)).toBe(false)
    expect(store.usage.summary().requests).toBe(4)
    expect(await rowCount(file)).toBe(4)
  })

  it("does not mistake a read-only file for corruption", async () => {
    if (process.platform !== "win32" && process.getuid?.() === 0) return // root ignores file modes
    const root = tempDir()
    const file = join(root, "usage.db")
    const trashDir = join(root, "trash")
    await seedDatabase(file, 2)

    const restore = makeReadOnly(file)
    try {
      const error = await captureError(() => Store.open({ path: file, trashDir, onWarn: () => {} }))
      expect(error).toBeInstanceOf(ModelInfraError)
      expect((error as ModelInfraError).code).toBe("STORAGE")
      expect((error as ModelInfraError).message).toMatch(/not writable/i)

      // A3: a permission problem must never quarantine the ledger.
      expect(trashIncidentDirs(trashDir)).toEqual([])
      expect(existsSync(file)).toBe(true)
    } finally {
      restore()
    }
    expect(await rowCount(file)).toBe(2)
  })

  it("keeps the original file in place when quarantine itself fails", async () => {
    const root = tempDir()
    const file = join(root, "usage.db")
    await seedDatabase(file, 2)
    const beforeBytes = corruptHeader(file)

    // The trash root cannot be created because its parent is a regular file.
    const blocked = join(root, "not-a-directory")
    writeFileSync(blocked, "occupied")

    const error = await captureError(() => Store.open({ path: file, trashDir: join(blocked, "trash"), onWarn: () => {} }))
    expect(error).toBeInstanceOf(ModelInfraError)
    expect((error as ModelInfraError).code).toBe("STORAGE")
    expect((error as ModelInfraError).message).toMatch(/corrupt/i)
    expect((error as ModelInfraError).message).toMatch(/nothing was deleted/i)

    // A4: never delete the data — the damaged file is still exactly where it was.
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file).equals(beforeBytes)).toBe(true)
    expect(existsSync(join(blocked, "trash"))).toBe(false)
  })

  it("skips the integrity check for a database above the startup budget", async () => {
    const root = tempDir()
    const file = join(root, "usage.db")
    await seedDatabase(file, 2)

    // A5: the file is over the budget, so `quick_check` must not run at all —
    // this driver proves it by failing loudly if it is asked for one.
    const warnings: string[] = []
    const noIntegrityDriver = async (target: string): Promise<SqlDriver> => {
      const real = await nodeSqliteDriver(target)
      return {
        exec: (sql: string) => real.exec(sql),
        prepare: (sql: string) => {
          if (/quick_check/i.test(sql)) throw new Error("PRAGMA quick_check must not run above the size budget")
          return real.prepare(sql)
        },
        close: () => real.close(),
      }
    }

    const store = await Store.open({
      path: file,
      driver: noIntegrityDriver,
      maxIntegrityCheckBytes: 1,
      onWarn: (message) => warnings.push(message),
    })
    stores.push(store)

    expect(store.usage.summary().requests).toBe(2)
    expect(await rowCount(file)).toBe(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Skipped the SQLite integrity check/i)
    expect(warnings[0]).toContain(file)
  })

  it("reports the size-budget skip once per process, not on every open", async () => {
    const root = tempDir()
    const file = join(root, "usage.db")
    await seedDatabase(file, 1)

    const warnings: string[] = []
    const first = await Store.open({ path: file, maxIntegrityCheckBytes: 1, onWarn: (m) => warnings.push(m) })
    stores.push(first)
    const second = await Store.open({ path: file, maxIntegrityCheckBytes: 1, onWarn: (m) => warnings.push(m) })
    stores.push(second)

    // A long-lived host reopens the same ledger; the notice is informational, so
    // once per process per path is enough (it used to fire on every open).
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Skipped the SQLite integrity check/i)
  })

  it("runs quick_check on a file-backed database and never on :memory:", async () => {    const root = tempDir()
    const file = join(root, "usage.db")
    await seedDatabase(file, 1)

    const seen: string[] = []
    const spyDriver = async (target: string): Promise<SqlDriver> => {
      const real = await nodeSqliteDriver(target)
      return {
        exec: (sql: string) => real.exec(sql),
        prepare: (sql: string) => {
          if (/quick_check/i.test(sql)) seen.push(target)
          return real.prepare(sql)
        },
        close: () => real.close(),
      }
    }

    const fileStore = await Store.open({ path: file, driver: spyDriver })
    stores.push(fileStore)
    expect(seen).toHaveLength(1)

    const memoryStore = await Store.open({ path: ":memory:", driver: spyDriver })
    stores.push(memoryStore)
    expect(seen).toHaveLength(1)
  })
})
