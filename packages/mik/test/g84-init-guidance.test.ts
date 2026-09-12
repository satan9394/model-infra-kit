import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseCliArgs } from "../src/cli/args.js"
import { loadConfig, openContext } from "../src/cli/context.js"
import { main } from "../src/cli/index.js"

/**
 * EVO-G84 (audit R232, F10 + F11) — the two `mik init` honesty gaps, both found by
 * running the published package:
 *
 * - F10: the closing guidance advertised `mik dashboard`, which **cannot run** in a
 *   packaged install (`apps/dashboard` is not in the tarball, `files: ["dist", "LICENSE"]`).
 *   Every step the guidance names must be a command this install can actually execute.
 * - F11: `mik init --cache-dir <dir>` accepted the flag and then silently dropped it:
 *   the written `mik.config.json` had no `cacheDir`, so the next command fell back to
 *   `~/.model-infra-kit/cache`. Silently ignoring a flag the user passed is the one
 *   outcome the card forbids.
 *
 * Both assertions below were red before the fix and are anchored on literals defined
 * here (the path handed to `--cache-dir`, the command name), never on a value read
 * back out of the object under test (R231).
 */

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g84-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const silentIo = { out: () => {}, err: () => {} }

interface Captured {
  code: number
  stdout: string
  stderr: string
}

/** In-process CLI run; `MIK_LANG=en` is pinned so no assertion follows the host locale. */
async function run(args: readonly string[], cwd: string): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, {
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    cwd,
    env: { ...process.env, MIK_LANG: "en" },
    interactive: false,
  })
  return { code, stdout: out.join(""), stderr: err.join("") }
}

/** The env `openContext` sees: no `MIK_CACHE_DIR`, so the config file is the only hint. */
function envWithoutCacheDir(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MIK_LANG: "en" }
  delete env.MIK_CACHE_DIR
  return env
}

describe("EVO-G84 / F10 — `init` only advertises steps a packaged install can run", () => {
  it("does not recommend `mik dashboard` (the app is not in the npm tarball)", async () => {
    const dir = tempDir()
    const configPath = join(dir, "mik.config.json")
    const result = await run(
      ["init", "--yes", "--offline", "--file", configPath, "--db", join(dir, "usage.db"), "--app-id", "f10"],
      dir,
    )
    expect(result.code).toBe(0)
    // External literals: the command name as the user would type it.
    expect(result.stdout).not.toContain("mik dashboard")
    // ...and the replacement step is itself a packaged command.
    expect(result.stdout).toContain("mik usage summary")
  })
})

describe("EVO-G84 / F11 — `mik init --cache-dir` is persisted and read back", () => {
  it("writes the flag into the config file instead of dropping it", async () => {
    const dir = tempDir()
    const configPath = join(dir, "mik.config.json")
    const cacheDir = join(dir, "cache")
    const result = await run(
      [
        "init",
        "--yes",
        "--offline",
        "--file",
        configPath,
        "--db",
        join(dir, "usage.db"),
        "--app-id",
        "f11",
        "--cache-dir",
        cacheDir,
      ],
      dir,
    )
    expect(result.code).toBe(0)
    const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
    expect(written.cacheDir).toBe(cacheDir)
    // The pre-existing fields must survive: the fix adds a key, it does not replace one.
    expect(written.appId).toBe("f11")
    expect(written.db).toBe(join(dir, "usage.db"))
  })

  it("a later command resolves the cache dir from the config file (flag → env → file)", async () => {
    const dir = tempDir()
    const configPath = join(dir, "mik.config.json")
    const fromFile = join(dir, "cache-file")
    const fromEnv = join(dir, "cache-env")
    const fromFlag = join(dir, "cache-flag")
    writeFileSync(
      configPath,
      `${JSON.stringify({ appId: "f11", db: join(dir, "usage.db"), cacheDir: fromFile }, null, 2)}\n`,
      "utf8",
    )

    const options = { cwd: dir, io: silentIo, interactive: false }
    const base = ["--config", configPath, "--offline"]

    const resolved = await openContext(parseCliArgs(base), { ...options, env: envWithoutCacheDir() })
    try {
      expect(resolved.cacheDir).toBe(fromFile)
    } finally {
      await resolved.close()
    }

    const overEnv = await openContext(parseCliArgs([...base, "--cache-dir", fromFlag]), {
      ...options,
      env: { ...envWithoutCacheDir(), MIK_CACHE_DIR: fromEnv },
    })
    try {
      expect(overEnv.cacheDir).toBe(fromFlag)
    } finally {
      await overEnv.close()
    }

    const byEnv = await openContext(parseCliArgs(base), {
      ...options,
      env: { ...envWithoutCacheDir(), MIK_CACHE_DIR: fromEnv },
    })
    try {
      expect(byEnv.cacheDir).toBe(fromEnv)
    } finally {
      await byEnv.close()
    }
  })

  it("reads a string cacheDir and refuses a non-string one", () => {
    const dir = tempDir()
    const good = join(dir, "good.json")
    const bad = join(dir, "bad.json")
    writeFileSync(good, `${JSON.stringify({ cacheDir: "relative/cache" })}\n`, "utf8")
    writeFileSync(bad, `${JSON.stringify({ cacheDir: 42 })}\n`, "utf8")
    expect(loadConfig(good, silentIo).cacheDir).toBe("relative/cache")
    expect(loadConfig(bad, silentIo).cacheDir).toBeUndefined()
  })
})
