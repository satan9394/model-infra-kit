import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseCliArgs } from "../src/cli/args.js"
import { openContext } from "../src/cli/context.js"
import { ModelInfra } from "../src/index.js"

/**
 * EVO-G05: the two precedence orders are locked here (documentation-only card —
 * behaviour must not change). CLI: flag → env → mik.config.json → built-in
 * default. Library: explicit config → env → default.
 */

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-prec-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const silentIo = { out: () => {}, err: () => {} }

describe("config precedence (locked, EVO-G05)", () => {
  it("CLI: flag beats env, env beats mik.config.json, config beats the default", async () => {
    const dir = tempDir()
    const db = join(dir, "usage.db")
    const configPath = join(dir, "mik.config.json")
    writeFileSync(configPath, `${JSON.stringify({ appId: "file-app", db }, null, 2)}\n`, "utf8")

    const base = ["--db", db, "--config", configPath, "--offline", "--cache-dir", join(dir, "cache")]
    const withEnv = { ...process.env, MIK_APP_ID: "env-app" }
    const options = { env: withEnv, cwd: dir, io: silentIo, interactive: false }

    const fromFlag = await openContext(parseCliArgs([...base, "--app-id", "flag-app"]), options)
    try {
      expect(fromFlag.appId).toBe("flag-app")
    } finally {
      await fromFlag.close()
    }

    const fromEnv = await openContext(parseCliArgs(base), options)
    try {
      expect(fromEnv.appId).toBe("env-app")
    } finally {
      await fromEnv.close()
    }

    // No env entry: the config file wins over the built-in default.
    const cleanEnv = { ...process.env }
    delete cleanEnv.MIK_APP_ID
    const fromFile = await openContext(parseCliArgs(base), { ...options, env: cleanEnv })
    try {
      expect(fromFile.appId).toBe("file-app")
    } finally {
      await fromFile.close()
    }
  })

  it("library: an explicit config.appId beats process.env.MIK_APP_ID", async () => {
    const dir = tempDir()
    const previous = process.env.MIK_APP_ID
    process.env.MIK_APP_ID = "env-app"
    try {
      const hub = await ModelInfra.init({
        appId: "explicit-app",
        db: join(dir, "library.db"),
        syncCatalog: false,
        onWarn: () => {},
      })
      try {
        expect(hub.appId).toBe("explicit-app")
      } finally {
        await hub.close()
      }
    } finally {
      if (previous === undefined) delete process.env.MIK_APP_ID
      else process.env.MIK_APP_ID = previous
    }
  })
})
