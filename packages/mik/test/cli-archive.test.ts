import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { it, expect } from "vitest"
import { runCommand } from "../src/cli/dispatch.js"
import { archiveDirectory, archiveStore } from "./archive-fixture.js"

it.each(["en_US.UTF-8", "zh_CN.UTF-8"])("runs all archive operations with injected %s and offline verification", async locale => {
  const cwd = archiveDirectory(), db = join(cwd, "ledger.db")
  const store = await archiveStore(db); store.close()
  const out: string[] = [], err: string[] = []
  const options = { cwd, env: { LC_ALL: locale, LANG: locale }, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } }
  for (const action of ["export", "verify", "prune"]) {
    expect(await runCommand(["db", "archive", action, "--help"], options)).toBe(0)
    expect(out.join("\n")).toContain(locale.startsWith("zh") ? (action === "verify" ? "离线" : action === "export" ? "压缩" : "校验") : (action === "verify" ? "offline" : action === "export" ? "compressed" : "atomically"))
    out.length = 0
  }
  expect(await runCommand(["db", "archive", "export", "--before", "2026-02-01", "--out", "archive", "--chunk-size", "10", "--db", db, "--offline"], options)).toBe(0)
  const manifest = join(cwd, "archive", "manifest.json")
  expect(existsSync(manifest)).toBe(true)
  const unopenedDb = join(cwd, "must-not-exist.db")
  expect(await runCommand(["db", "archive", "verify", "--manifest", manifest, "--db", unopenedDb], options)).toBe(0)
  expect(existsSync(unopenedDb)).toBe(false)
  expect(await runCommand(["db", "archive", "prune", "--manifest", manifest, "--db", db, "--vacuum", "--offline"], options)).toBe(0)
  expect(await runCommand(["db", "archive", "prune", "--manifest", manifest, "--db", db, "--offline"], options)).toBe(1)
  writeFileSync(manifest, "corrupt")
  expect(await runCommand(["db", "archive", "verify", "--manifest", manifest], options)).toBe(1)
  expect(out.join("\n")).toContain(locale.startsWith("zh") ? "校验通过" : "Archive verified")
})

it("rejects invalid dates, counts, subcommands and misplaced flags before opening a DB", async () => {
  const cwd = archiveDirectory(), db = join(cwd, "absent.db")
  const options = { cwd, env: { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }, io: { out: () => {}, err: () => {} } }
  for (const args of [
    ["export", "--before", "2026-02-30", "--out", "new"],
    ["export", "--before", "2026-02-01", "--out", "new", "--chunk-size", "0"],
    ["verify"], ["prune"], ["unknown"], ["verify", "--before", "2026-02-01"],
  ]) expect(await runCommand(["db", "archive", ...args, "--db", db], options)).toBe(2)
  expect(existsSync(db)).toBe(false)
})
