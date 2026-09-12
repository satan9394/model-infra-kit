import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import {
  DASHBOARD_PACKAGING_HINT,
  findDashboardDir,
  missingDashboardError,
  DASHBOARD_RELATIVE_DIR,
} from "../src/cli/commands/dashboard.js"
import { main } from "../src/cli/index.js"

/**
 * EVO-G69 — `mik dashboard` honesty (G57) and localization (G68).
 *
 * Every assertion here injects `MIK_LANG`; nothing reads the host locale. The
 * language is asserted on the message *body*, never on the `错误： ` prefix:
 * that prefix is Chinese in every language, so "the output contains Chinese"
 * would be vacuously true.
 *
 * Pre-change status of each assertion is recorded in `.tmp/impl-G69.md`; the
 * dashboard body assertions were red (hardcoded English), the dead-key guard in
 * `i18n-dead-keys.test.ts` was red with 6 keys.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g69-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

interface Captured {
  code: number
  stdout: string
  stderr: string
}

/** In-process CLI run; `MIK_LANG` defaults to `en`, exactly like `cli.test.ts`. */
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

/** The `dashboard` row of the COMMANDS block. */
function dashboardLine(text: string): string {
  return text.split("\n").find((line) => /^\s{2}dashboard\s/.test(line)) ?? ""
}

/**
 * The claims the packaged README makes, which the help line must not contradict
 * (`packages/mik/README.md`): the npm package does not contain the dashboard,
 * and the dashboard only runs from a repository clone.
 */
const README_CLAIM_ZH = "本包不含看板"
const README_CLAIM_EN_PACKAGE = "not in the npm package"
const README_CLAIM_EN_CLONE = "clone"
const README_CLAIM_ZH_CLONE = "克隆"

// ---------------------------------------------------------------------------
// G57 — the help no longer presents the command as boxed-and-ready
// ---------------------------------------------------------------------------

describe("EVO-G69 / G57 — `dashboard` states its packaging boundary in --help", () => {
  it("qualifies the dashboard line of the Chinese root help", async () => {
    const { code, stdout } = await run(["--help"], tempDir(), { MIK_LANG: "zh" })
    expect(code).toBe(0)
    const line = dashboardLine(stdout)
    expect(line, "no dashboard row in the COMMANDS block").not.toBe("")
    // The old, unqualified wording must be gone.
    expect(line).not.toMatch(/^\s{2}dashboard\s+启动看板应用（默认 3210）\s*$/)
    expect(line).toContain("npm 包不含")
    expect(line).toContain(README_CLAIM_ZH_CLONE)
  })

  it("qualifies the dashboard line of the English root help", async () => {
    const { code, stdout } = await run(["--help"], tempDir(), { MIK_LANG: "en" })
    expect(code).toBe(0)
    const line = dashboardLine(stdout)
    expect(line).not.toBe("")
    expect(line).not.toMatch(/^\s{2}dashboard\s+Start the dashboard app \(default 3210\)\s*$/)
    expect(line).toContain(README_CLAIM_EN_PACKAGE)
    expect(line).toContain(README_CLAIM_EN_CLONE)
  })

  it("uses the packaged README's wording instead of inventing a second story", () => {
    // The npm user reads `packages/mik/README.md`; the help must agree with it.
    const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8")
    expect(readme).toContain(README_CLAIM_ZH)
    expect(readme).toContain("apps/dashboard")
    expect(readme).toContain("monorepo")
  })

  it("carries the same boundary into `mik dashboard --help`, localized", async () => {
    const zh = await run(["dashboard", "--help"], tempDir(), { MIK_LANG: "zh" })
    expect(zh.code).toBe(0)
    expect(zh.stdout).toContain("npm 包不含")
    // A second, explicit sentence in the command's own help.
    expect(zh.stdout).toContain("看板不随 npm 包发布")
    // The English sentence must not survive in the Chinese surface...
    expect(zh.stdout).not.toContain("Not shipped in the npm package")
    // ...and the data on it stays verbatim.
    expect(zh.stdout).toContain("apps/dashboard")
    expect(zh.stdout).toContain("--dir")

    const en = await run(["dashboard", "--help"], tempDir(), { MIK_LANG: "en" })
    expect(en.code).toBe(0)
    expect(en.stdout).toContain("Not shipped in the npm package")
    expect(en.stdout).not.toContain("看板不随")
  })
})

// ---------------------------------------------------------------------------
// G68 — the four dashboard failure bodies follow MIK_LANG
// ---------------------------------------------------------------------------

describe("EVO-G69 / G68 — dashboard failures speak Chinese under MIK_LANG=zh", () => {
  it("renders `dashboard.error.missingApp` in Chinese, with the data untouched", async () => {
    // `MIK_DASHBOARD_DIR=""` forces the "no dashboard app resolved" branch that a
    // package installed from npm always hits (inside the monorepo the walk-up
    // would otherwise find `apps/dashboard`).
    const { code, stderr } = await run(["dashboard", "--port", "39117"], tempDir(), {
      MIK_LANG: "zh",
      MIK_DASHBOARD_DIR: "",
    })
    expect(code).toBe(1)
    // Body, not prefix: `错误： ` is Chinese in both languages.
    expect(stderr).toContain("找不到看板应用")
    expect(stderr).not.toContain("Could not find the dashboard app")
    // The whole packaging hint is translated, not just its first line.
    expect(stderr).toContain("看板不会随 npm 包发布")
    expect(stderr).not.toContain("The dashboard is not published with the npm package")
    // Data stays verbatim (paths, commands, placeholders).
    expect(stderr).toContain("apps/dashboard")
    expect(stderr).toContain("pnpm --filter @mik/dashboard dev")
    expect(stderr).toContain("mik dashboard --dir <path>")
  })

  it("renders `dashboard.error.notAPackage` in Chinese", async () => {
    const empty = tempDir()
    const { code, stderr } = await run(["dashboard", "--port", "39118", "--dir", empty], tempDir(), { MIK_LANG: "zh" })
    expect(code).toBe(1)
    expect(stderr).toContain("看起来不是一个包")
    expect(stderr).not.toContain("does not look like a package")
    // The directory itself is data, and it survives.
    expect(stderr).toContain(empty)
    expect(stderr).toContain("package.json")
  })

  it("renders `dashboard.error.noEntryPoint` in Chinese", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "package.json"), "{}\n")
    const { code, stderr } = await run(["dashboard", "--port", "39119", "--dir", dir], tempDir(), {
      MIK_LANG: "zh",
      // No pnpm shim on PATH and no `node_modules/next`: the unreachable-entry branch.
      PATH: "",
      npm_execpath: "",
    })
    expect(code).toBe(1)
    expect(stderr).toContain("没有本地的 next 安装")
    expect(stderr).not.toContain("no local next install in")
    expect(stderr).toContain("pnpm")
    expect(stderr).toContain("PATH")
    expect(stderr).toContain(dir)
  })

  it("renders `dashboard.error.spawnFailed` in Chinese", async () => {
    // The child-spawn failure cannot be produced through the public CLI: the
    // launcher only ever spawns `process.execPath` with an absolute script path,
    // so `spawn()` raises no `error` event (a missing `next` exits non-zero
    // instead, which is the `exit` branch). The wiring is therefore asserted
    // through the exported helper plus the source-level check below, and that
    // gap is declared in the report rather than papered over.
    const mod = (await import("../src/cli/commands/dashboard.js")) as Record<string, unknown>
    const spawnFailed = mod.dashboardSpawnError as ((error: unknown, lang?: string) => Error) | undefined
    expect(typeof spawnFailed, "dashboardSpawnError must be exported for the error branch").toBe("function")
    if (!spawnFailed) return
    const zh = spawnFailed(new Error("spawn EINVAL"), "zh")
    expect(zh.message).toContain("无法启动看板")
    expect(zh.message).not.toContain("Could not start the dashboard")
    // The underlying message is data and stays as-is.
    expect(zh.message).toContain("spawn EINVAL")
  })

  it("leaves no hardcoded dashboard failure literal in the source", () => {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "cli", "commands", "dashboard.ts"), "utf8")
    for (const literal of [
      "Could not find the dashboard app",
      "does not look like a package",
      "no local next install in",
      "Could not start the dashboard: ",
    ]) {
      expect(source, `hardcoded English left in dashboard.ts: ${literal}`).not.toContain(literal)
    }
    for (const key of [
      "dashboard.error.missingApp",
      "dashboard.error.notAPackage",
      "dashboard.error.noEntryPoint",
      "dashboard.error.spawnFailed",
      "dashboard.hint.packaging",
    ]) {
      expect(source, `unwired key ${key}`).toContain(key)
    }
    // The lang used is the invocation language already resolved in scope.
    expect(source).toContain("invocationLang(options)")
  })
})

// ---------------------------------------------------------------------------
// A4 — the English surface is byte-identical to the pre-change build
// ---------------------------------------------------------------------------

describe("EVO-G69 / A4 — the English dashboard surface is unchanged", () => {
  it("keeps `dashboard.error.missingApp` byte-identical in English", () => {
    const message = missingDashboardError("en").message
    // The packaging hint constant is the English source of truth and was not touched.
    expect(message).toBe(`Could not find the dashboard app (apps/dashboard).\n${DASHBOARD_PACKAGING_HINT}`)
    expect(DASHBOARD_PACKAGING_HINT).toContain("model-infra-kit ships the library, the CLI and the HTTP server only.")
    expect(DASHBOARD_PACKAGING_HINT).toContain('  See the "Dashboard" section of the project README.')
  })

  it("keeps the other three English bodies byte-identical", async () => {
    const empty = tempDir()
    const notAPackage = await run(["dashboard", "--port", "39128", "--dir", empty], tempDir(), { MIK_LANG: "en" })
    expect(notAPackage.stderr).toContain(`${empty} does not look like a package (no package.json).`)
    expect(notAPackage.stderr).toContain(DASHBOARD_PACKAGING_HINT)

    const dir = tempDir()
    writeFileSync(join(dir, "package.json"), "{}\n")
    const noEntryPoint = await run(["dashboard", "--port", "39129", "--dir", dir], tempDir(), {
      MIK_LANG: "en",
      PATH: "",
      npm_execpath: "",
    })
    expect(noEntryPoint.stderr).toContain(
      `Could not start the dashboard: no local next install in ${dir} and no pnpm entry point on PATH.`,
    )

    const mod = (await import("../src/cli/commands/dashboard.js")) as Record<string, unknown>
    const spawnFailed = mod.dashboardSpawnError as ((error: unknown, lang?: string) => Error) | undefined
    if (spawnFailed) {
      expect(spawnFailed(new Error("spawn EINVAL"), "en").message).toBe("Could not start the dashboard: spawn EINVAL")
    }
    // The default argument keeps the English signature source-compatible.
    expect(missingDashboardError().message).toBe(`Could not find the dashboard app (apps/dashboard).\n${DASHBOARD_PACKAGING_HINT}`)
  })

  it("keeps the monorepo resolution path working (the real `--dir`-free success path)", () => {
    // Inside the repository the launcher must still find `apps/dashboard`; that
    // resolution is what `mik dashboard` in the monorepo and
    // `mik dashboard --dir <own copy>` both depend on. Starting the Next server
    // itself is *not* covered here (see the report's A4 gap note).
    expect(DASHBOARD_RELATIVE_DIR).toBe(join("apps", "dashboard"))
    const found = findDashboardDir(PACKAGE_ROOT)
    expect(found).not.toBeNull()
    expect(existsSync(join(found!, "package.json"))).toBe(true)
  })
})
