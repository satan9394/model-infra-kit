import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterAll, describe, expect, it, vi } from "vitest"
import { COMMANDS, parseCliArgs } from "../src/cli/args.js"
import { openContext, offlineFetch } from "../src/cli/context.js"
import { USAGE_CSV_HEADER, usageCsv, usageCsvRow } from "../src/cli/csv.js"
import { formatMoney, formatTable, formatTokens } from "../src/cli/format.js"
import { isDirectInvocation, main } from "../src/cli/index.js"
import { netstatShowsPort, portInUse } from "../src/cli/ports.js"
import { CliUsageError } from "../src/cli/errors.js"
import { findDashboardDir, findPnpmScript, missingDashboardError, walkUpFor } from "../src/cli/commands/dashboard.js"
import { loadServerModule, resolveCorsFlag, resolveServerModuleUrl, serverModuleCandidates } from "../src/cli/commands/serve.js"
import type { ModelInfraOptions } from "../src/hub.js"
import { Store } from "../src/store/database.js"
import type { UsageEvent } from "../src/types.js"
import { UsageService } from "../src/usage/service.js"

/**
 * The interactive `mik init` wizard is exercised headless: `prompt()` would
 * otherwise create a readline on the test process stdin and block forever.
 * The mock keeps the module's other exports intact for every command that
 * imports prompt.js (init / repl / index / provider).
 */
const promptMock = vi.hoisted(() => ({ prompt: vi.fn() }))
vi.mock("../src/cli/prompt.js", () => ({
  isInteractive: (options: { interactive?: boolean } = {}) => options.interactive === true,
  prompt: promptMock.prompt,
  isAffirmative: (answer: string) => /^\s*y(es)?\s*$/i.test(answer),
}))

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-cli-"))
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

/** Run the CLI in-process with captured streams. Every call is offline by construction. */
async function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, {
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    cwd,
    env: { ...process.env, ...env },
    interactive: false,
  })
  return { code, stdout: out.join("\n"), stderr: err.join("\n") }
}

/** A temp database plus the flags that keep a run off the network. */
function sandbox(): { dir: string; db: string; base: string[] } {
  const dir = tempDir()
  const db = join(dir, "usage.db")
  return { dir, db, base: ["--offline", "--db", db, "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")] }
}

describe("isDirectInvocation (Unix bin symlink)", () => {
  const selfPath = realpathSync(fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)))

  it("accepts the real path and rejects an unrelated file", () => {
    const dir = tempDir()
    expect(isDirectInvocation(["node", selfPath])).toBe(true)
    expect(isDirectInvocation(["node", join(dir, "somewhere-else.js")])).toBe(false)
    expect(isDirectInvocation(["node"])).toBe(false)
  })

  it("accepts an npm bin symlink pointing at this module", () => {
    // npm's Unix bin is a symlink to dist/cli.mjs; argv[1] is then the link path
    // while import.meta.url is the resolved real path. This is the regression
    // for the Linux/macOS `mik` silently doing nothing.
    const dir = tempDir()
    const link = join(dir, "mik")
    try {
      symlinkSync(selfPath, link)
    } catch {
      // Windows without Developer Mode cannot create file symlinks; skip there.
      return
    }
    expect(isDirectInvocation(["node", link])).toBe(true)
  })
})

describe("parseCliArgs", () => {
  it("resolves commands, actions and positionals", () => {
    const parsed = parseCliArgs(["provider", "add", "deepseek", "--preset", "deepseek"])
    expect(parsed.command?.name).toBe("provider")
    expect(parsed.action?.name).toBe("add")
    expect(parsed.args).toEqual(["deepseek"])
    expect(parsed.values.preset).toBe("deepseek")
  })

  it("maps kebab-case flags onto camelCase keys", () => {
    const parsed = parseCliArgs([
      "provider",
      "add",
      "x",
      "--api-key-ref",
      "env:FOO",
      "--base-url",
      "https://example.test/v1",
      "--app-id",
      "my-app",
    ])
    expect(parsed.values.apiKeyRef).toBe("env:FOO")
    expect(parsed.values.baseUrl).toBe("https://example.test/v1")
    expect(parsed.values.appId).toBe("my-app")
  })

  it("treats a bare invocation and --help as help", () => {
    expect(parseCliArgs([]).help).toBe(false)
    expect(parseCliArgs([]).command).toBeNull()
    expect(parseCliArgs(["--help"]).help).toBe(true)
    expect(parseCliArgs(["provider", "--help"]).command?.name).toBe("provider")
    expect(parseCliArgs(["provider", "add", "-h"]).action?.name).toBe("add")
  })

  it("rejects an unknown command", () => {
    expect(() => parseCliArgs(["nope"])).toThrow(CliUsageError)
  })

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["provider", "list", "--nope"])).toThrow(CliUsageError)
  })

  it("rejects a flag that belongs to another command", () => {
    expect(() => parseCliArgs(["usage", "summary", "--port", "1234"])).toThrow(CliUsageError)
  })

  it("rejects a missing action", () => {
    expect(() => parseCliArgs(["provider"])).toThrow(CliUsageError)
    expect(() => parseCliArgs(["provider", "bogus"])).toThrow(CliUsageError)
  })

  it("declares every command exactly once", () => {
    const names = COMMANDS.map((command) => command.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("formatting", () => {
  it("prints money with four decimals", () => {
    expect(formatMoney(0.012345)).toBe("0.0123")
    expect(formatMoney(1.1)).toBe("1.1000")
    expect(formatMoney(0)).toBe("0.0000")
    expect(formatMoney(Number.NaN)).toBe("n/a")
  })

  it("groups token counts with thousands separators", () => {
    expect(formatTokens(1234567)).toBe("1,234,567")
    expect(formatTokens(0)).toBe("0")
  })

  it("aligns a table and trims trailing padding", () => {
    const table = formatTable(["A", "B"], [["1", "22"]], ["left", "right"])
    const lines = table.split("\n")
    expect(lines[0]).toBe("A   B")
    expect(lines[1]).toBe("-  --")
    expect(lines[2]).toBe("1  22")
  })
})

describe("usageCsv", () => {
  const event: UsageEvent = {
    requestId: "r-1",
    appId: "cli-app",
    ts: Date.parse("2026-09-01T10:00:00.000Z"),
    source: "generate",
    providerId: "deepseek",
    modelRequested: "deepseek:deepseek-chat",
    modelActual: "deepseek-chat",
    usage: { input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 },
    cost: { usd: 0.012345, low: 0.01, high: 0.02, basis: "flat", source: "modelsdev" },
    latencyMs: 850,
    status: "ok",
    isStreaming: false,
  }

  it("keeps the header fixed and column order stable", () => {
    expect(USAGE_CSV_HEADER).toBe(
      "ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms",
    )
    expect(USAGE_CSV_HEADER.split(",")).toHaveLength(14)
  })

  it("renders one row per event, oldest first", () => {
    const csv = usageCsv([{ ...event, requestId: "r-2", ts: event.ts + 1000 }, event])
    const lines = csv.trimEnd().split("\n")
    expect(lines[0]).toBe(USAGE_CSV_HEADER)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(
      "2026-09-01T10:00:00.000Z,cli-app,deepseek,deepseek-chat,ok,1200,300,800,0,64,0.0123,modelsdev,flat,850",
    )
    expect(lines[2]?.startsWith("2026-09-01T10:00:01.000Z")).toBe(true)
  })

  it("quotes fields that contain a comma or a quote", () => {
    const row = usageCsvRow({ ...event, modelActual: 'weird,"model"' })
    expect(row).toContain('"weird,""model"""')
  })

  it("leaves a missing latency empty rather than writing null", () => {
    const row = usageCsvRow({ ...event, latencyMs: undefined })
    expect(row.endsWith(",850")).toBe(false)
    expect(row.split(",").at(-1)).toBe("")
  })
})

describe("help and version", () => {
  it("prints root help", async () => {
    const { dir } = sandbox()
    const result = await run(["--help"], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("USAGE")
    expect(result.stdout).toContain("provider")
    expect(result.stdout).toContain("usage")
  })

  it("prints help for a command and an action", async () => {
    const { dir } = sandbox()
    const commandHelp = await run(["provider", "--help"], dir)
    expect(commandHelp.code).toBe(0)
    expect(commandHelp.stdout).toContain("mik provider")
    expect(commandHelp.stdout).toContain("add")

    const actionHelp = await run(["provider", "add", "--help"], dir)
    expect(actionHelp.code).toBe(0)
    expect(actionHelp.stdout).toContain("mik provider add <id>")
    expect(actionHelp.stdout).toContain("--api-key-ref")
  })

  it("prints a version", async () => {
    const { dir } = sandbox()
    const result = await run(["--version"], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^mik \d+\.\d+\.\d+/)
  })

  it("prints usage errors on stderr with exit code 2", async () => {
    const { dir } = sandbox()
    const result = await run(["provider", "list", "--nope"], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("error:")
    expect(result.stdout).toBe("")
  })
})

describe("provider add", () => {
  it("completes protocol, base URL and name from the preset and explains the missing key ref", async () => {
    const { dir, base } = sandbox()
    const result = await run(["provider", "add", "deepseek", "--preset", "deepseek", ...base], dir)
    expect(result.code).toBe(0)
    // Criterion 3: an explicit notice instead of silently relying on plaintext.
    expect(result.stdout).toContain("no --api-key-ref given")
    expect(result.stdout).toContain("DEEPSEEK_API_KEY")
    expect(result.stdout).toContain("no secret is stored")
    // Preset completion, visible in the record table.
    expect(result.stdout).toContain("deepseek")
    expect(result.stdout).toContain("https://api.deepseek.com/v1")

    const listed = await run(["provider", "list", ...base], dir)
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain("https://api.deepseek.com/v1")
    expect(listed.stdout).toContain("deepseek")
  })

  it("keeps a credential reference but never the secret itself", async () => {
    const { dir, base } = sandbox()
    const secret = "sk-live-9f8e7d6c5b4a3f2e1d0c"
    const result = await run(
      ["provider", "add", "deepseek", "--preset", "deepseek", "--api-key-ref", "env:DEEPSEEK_API_KEY", ...base],
      dir,
      { DEEPSEEK_API_KEY: secret },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("env:DEEPSEEK_API_KEY")
    expect(result.stdout).not.toContain(secret)
    expect(result.stderr).not.toContain(secret)

    const listed = await run(["provider", "list", ...base], dir, { DEEPSEEK_API_KEY: secret })
    expect(listed.stdout).toContain("env:DEEPSEEK_API_KEY")
    expect(listed.stdout).not.toContain(secret)
  })

  it("refuses a plaintext key as a reference", async () => {
    const { dir, base } = sandbox()
    const secret = "plaintext-key-should-never-be-stored"
    const result = await run(["provider", "add", "openai", "--preset", "openai", "--api-key-ref", secret, ...base], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("env:VAR")
    expect(result.stdout).not.toContain(secret)
    expect(result.stderr).not.toContain(secret)
  })

  it("rejects an unknown preset", async () => {
    const { dir, base } = sandbox()
    const result = await run(["provider", "add", "x", "--preset", "not-a-preset", ...base], dir)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/preset/i)
  })

  it("requires the provider id", async () => {
    const { dir, base } = sandbox()
    const result = await run(["provider", "add", ...base], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("<id>")
  })
})

describe("init", () => {
  it("writes mik.config.json and registers the first provider", async () => {
    const { dir, db } = sandbox()
    const configPath = join(dir, "mik.config.json")
    const result = await run(
      [
        "init",
        "--app-id",
        "cli-app",
        "--db",
        db,
        "--provider",
        "deepseek",
        "--file",
        configPath,
        "--config",
        configPath,
        "--yes",
        "--offline",
        "--cache-dir",
        join(dir, "cache"),
      ],
      dir,
    )
    expect(result.code).toBe(0)

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      appId: string
      db: string
      initialProviders: Array<{ id: string; apiKeyRef?: string }>
    }
    expect(config.appId).toBe("cli-app")
    expect(config.db).toBe(db)
    expect(config.initialProviders[0]?.id).toBe("deepseek")
    expect(config.initialProviders[0]?.apiKeyRef).toBe("env:DEEPSEEK_API_KEY")

    const listed = await run(["provider", "list", "--offline", "--db", db, "--cache-dir", join(dir, "cache"), "--config", configPath], dir)
    expect(listed.stdout).toContain("deepseek")
  })

  it("refuses to overwrite an existing config without --force", async () => {
    const { dir, db } = sandbox()
    const configPath = join(dir, "mik.config.json")
    writeFileSync(configPath, "{}\n", "utf8")
    const result = await run(["init", "--db", db, "--file", configPath, "--yes", "--offline"], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--force")
  })

  it("resolves MIK_LANG=en over a stored cli.lang=zh even non-interactively", async () => {
    const { dir, db, base } = sandbox()
    const configPath = join(dir, "mik.config.json")

    // Pre-seed the stored setting on the same database the init run will open.
    const preset = await openContext(parseCliArgs(base), {
      cwd: dir,
      env: { ...process.env },
      io: { out: () => {}, err: () => {} },
      interactive: false,
    })
    preset.hub.writeSetting("cli.lang", "zh")
    await preset.close()

    const result = await run(
      [
        "init",
        "--app-id",
        "cli-app",
        "--db",
        db,
        "--provider",
        "deepseek",
        "--file",
        configPath,
        "--yes",
        ...base,
      ],
      dir,
      { MIK_LANG: "en" },
    )
    expect(result.code).toBe(0)

    // Config structure is unchanged: appId/db/initialProviders only.
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      appId: string
      db: string
      initialProviders: Array<{ id: string; apiKeyRef?: string }>
    }
    expect(config.appId).toBe("cli-app")
    expect(config.db).toBe(db)
    expect(config.initialProviders[0]?.id).toBe("deepseek")
    expect(config.initialProviders[0]?.apiKeyRef).toBe("env:DEEPSEEK_API_KEY")

    // The resolved language (env wins over the stored zh) was persisted.
    const check = await openContext(parseCliArgs(base), {
      cwd: dir,
      env: { ...process.env },
      io: { out: () => {}, err: () => {} },
      interactive: false,
    })
    expect(check.hub.readSetting("cli.lang")).toBe("en")
    await check.close()
  })

  it("prints the init output in zh when the injected locale is zh (G29)", async () => {
    const { dir, db, base } = sandbox()
    const configPath = join(dir, "mik.config.json")
    // LC_ALL pins the OS-locale branch: no MIK_LANG, no stored cli.lang, so the
    // resolved language is zh. Nothing here reads the runner's real locale.
    const result = await run(
      ["init", "--app-id", "cli-app", "--db", db, "--provider", "deepseek", "--file", configPath, "--yes", ...base],
      dir,
      { LC_ALL: "zh_CN.UTF-8", MIK_LANG: "" },
    )
    expect(result.code).toBe(0)
    // Structure and order are unchanged: wrote-line, appId, db, provider line.
    expect(result.stdout).toContain(`已写入 ${configPath}`)
    expect(result.stdout).toContain("  appId  cli-app")
    expect(result.stdout).toContain(`  db     ${db}`)
    expect(result.stdout).toContain("已注册供应商")
    expect(result.stdout).not.toContain("Wrote ")
  })

  it("prints the init output in en when MIK_LANG=en (G29)", async () => {
    const { dir, db, base } = sandbox()
    const configPath = join(dir, "mik.config.json")
    const result = await run(
      ["init", "--app-id", "cli-app", "--db", db, "--provider", "deepseek", "--file", configPath, "--yes", ...base],
      dir,
      { MIK_LANG: "en", LC_ALL: "zh_CN.UTF-8" },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`Wrote ${configPath}`)
    expect(result.stdout).toContain("  appId  cli-app")
    expect(result.stdout).toContain(`  db     ${db}`)
    expect(result.stdout).toContain("Registered provider")
    expect(result.stdout).not.toContain("已写入")
  })

  it("asks the wizard fields in the language chosen at the lang prompt", async () => {    const { dir, base } = sandbox()
    const configPath = join(dir, "mik.config.json")
    promptMock.prompt.mockReset()
    promptMock.prompt
      .mockResolvedValueOnce("1") // wizard.lang → 中文
      .mockResolvedValueOnce("") // appId (default)
      .mockResolvedValueOnce("") // db (default)
      .mockResolvedValueOnce("") // provider (skip)

    const result = await main(
      ["init", "--file", configPath, ...base],
      { io: { out: () => {}, err: () => {} }, cwd: dir, env: { ...process.env, MIK_LANG: "en" }, interactive: true },
    )
    expect(result).toBe(0)
    const questions = promptMock.prompt.mock.calls.map((call) => String(call[0]))
    expect(questions).toHaveLength(4)
    // env MIK_LANG=en → first question is English; picking 1 switches the rest to zh.
    expect(questions[0]).toContain("Select (1: 中文  2: English)")
    expect(questions[1]).toContain("应用 id")
    expect(questions[2]).toContain("数据库")
    expect(questions[3]).toContain("预设")
  })

  it("retries the language prompt once on a bogus answer and follows the retry", async () => {
    const { dir, base } = sandbox()
    const configPath = join(dir, "mik.config.json")
    const stderr: string[] = []
    promptMock.prompt.mockReset()
    promptMock.prompt
      .mockResolvedValueOnce("garbage") // invalid → wizard.langInvalid + retry
      .mockResolvedValueOnce("2") // retry → English
      .mockResolvedValueOnce("") // appId (default)
      .mockResolvedValueOnce("") // db (default)
      .mockResolvedValueOnce("") // provider (skip)

    const result = await main(
      ["init", "--file", configPath, ...base],
      // No MIK_LANG and no stored setting: the wizard follows the OS locale, so
      // pin it (LC_ALL wins over LANG/LC_MESSAGES) instead of trusting the
      // runner's locale — CI is usually en_*.
      { io: { out: () => {}, err: (text) => stderr.push(text) }, cwd: dir, env: { ...process.env, LC_ALL: "zh_CN.UTF-8" }, interactive: true },
    )
    expect(result).toBe(0)
    expect(stderr.join("\n")).toContain("请输入 1 或 2")
    const questions = promptMock.prompt.mock.calls.map((call) => String(call[0]))
    expect(questions).toHaveLength(5)
    // Locale pinned to zh_CN.UTF-8 → the wizard starts in zh for both attempts.
    expect(questions[0]).toContain("Choose a language")
    expect(questions[1]).toContain("Choose a language")
    // The retry picked 2 → the field prompts follow English.
    expect(questions[2]).toContain("Application id")
    expect(questions[3]).toContain("SQLite database path")
  })
})

describe("docs consistency (EVO-G02/G06)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
  const doc = (relative: string) => readFileSync(join(repoRoot, relative), "utf8")

  it("keeps version, publish status, --cors and the events endpoint in sync", () => {
    const readme = doc("README.md")
    const guide = doc("docs/agent-cli-guide.md")
    const playbook = doc("docs/integration-playbook.md")
    // No stale version number anywhere the user reads.
    expect(readme).not.toContain("0.1.1")
    expect(playbook).not.toContain("0.1.1")
    // Publish status, --cors and /api/usage/events must not contradict the CLI.
    expect(guide).not.toContain("尚未发布到 npm")
    expect(playbook).not.toContain("CLI 无 --cors 开关")
    expect(playbook).not.toContain("仓库不存在（实测 404）")
    // The README documents the upgrade path with the Node version floor.
    expect(readme).toContain("npm update model-infra-kit")
    expect(readme).toContain("22.13")
  })
})

describe("port checks", () => {
  it("parses netstat output", () => {
    const sample = [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:3211         0.0.0.0:0              LISTENING       4242",
      "  TCP    127.0.0.1:3212         127.0.0.1:55555        ESTABLISHED     4242",
      "  TCP    [::]:3210              [::]:0                 LISTENING       99",
    ].join("\r\n")
    expect(netstatShowsPort(sample, 3211)).toBe(true)
    expect(netstatShowsPort(sample, 3210)).toBe(true)
    expect(netstatShowsPort(sample, 3212)).toBe(false)
    expect(netstatShowsPort(sample, 321)).toBe(false)
  })

  it("sees a real listening port and refuses to start a server on it", async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      expect(await portInUse(port)).toBe(true)
      const { dir, base } = sandbox()
      const result = await run(["serve", "--port", String(port), ...base], dir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("already in use")
      expect(result.stderr).toContain(String(port))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("reports a free port as free", async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await portInUse(port)).toBe(false)
  })
})

describe("serve bundle resolution", () => {
  /**
   * A fake built package tree: `<root>/packages/mik/dist/{cli.mjs,server.mjs}`
   * plus a decoy at `<root>/packages/server/index.ts`, the path the old
   * source-only candidate list walked up to from `dist/cli.mjs`.
   */
  function distLayout(): { cli: string; sibling: string; decoy: string } {
    const root = tempDir()
    const dist = join(root, "packages", "mik", "dist")
    mkdirSync(dist, { recursive: true })
    const cli = join(dist, "cli.mjs")
    const sibling = join(dist, "server.mjs")
    writeFileSync(cli, "export {}\n", "utf8")
    writeFileSync(sibling, "export function createServer() { return { url: 'x', close() {} } }\n", "utf8")

    const decoy = join(root, "packages", "server", "index.ts")
    mkdirSync(dirname(decoy), { recursive: true })
    writeFileSync(decoy, "export function createServer() {}\n", "utf8")
    return { cli, sibling, decoy }
  }

  it("resolves the sibling server.mjs when the CLI runs from dist", () => {
    const { cli, sibling } = distLayout()
    expect(fileURLToPath(resolveServerModuleUrl(pathToFileURL(cli).href))).toBe(sibling)
  })

  it("never escapes the package into a parent directory when a sibling bundle exists", () => {
    const { cli, sibling, decoy } = distLayout()
    const candidates = serverModuleCandidates(pathToFileURL(cli).href).map((url) => fileURLToPath(url))
    expect(candidates[0]).toBe(sibling)
    // The decoy exists on disk, so only ordering keeps resolution inside dist/.
    const chosen = fileURLToPath(resolveServerModuleUrl(pathToFileURL(cli).href))
    expect(chosen).toBe(sibling)
    expect(chosen).not.toBe(resolve(decoy))
    expect(chosen.startsWith(dirname(cli))).toBe(true)
  })

  it("resolves the source layout when the CLI runs from src/cli/commands", () => {
    const root = tempDir()
    const commands = join(root, "src", "cli", "commands")
    mkdirSync(commands, { recursive: true })
    const serveFile = join(commands, "serve.ts")
    writeFileSync(serveFile, "export {}\n", "utf8")
    const serverIndex = join(root, "src", "server", "index.ts")
    mkdirSync(dirname(serverIndex), { recursive: true })
    writeFileSync(serverIndex, "export {}\n", "utf8")
    expect(fileURLToPath(resolveServerModuleUrl(pathToFileURL(serveFile).href))).toBe(serverIndex)
  })

  it("loads the real server bundle for the layout the tests run in", async () => {
    const module = await loadServerModule()
    expect(typeof module.createServer).toBe("function")
  })

  it("lists every candidate it tried when no layout matches", () => {
    const root = tempDir()
    const cli = join(root, "cli.mjs")
    writeFileSync(cli, "export {}\n", "utf8")
    expect(() => resolveServerModuleUrl(pathToFileURL(cli).href)).toThrow(/server\.mjs/)
    expect(() => resolveServerModuleUrl(pathToFileURL(cli).href)).toThrow(/mik\/server/)
  })
})

describe("resolveCorsFlag (T14)", () => {
  it("maps '*' to any-origin mode and a URL to a fixed origin", () => {
    expect(resolveCorsFlag(undefined)).toBeUndefined()
    expect(resolveCorsFlag("*")).toBe(true)
    expect(resolveCorsFlag("*:*")).toBe(true)
    expect(resolveCorsFlag("https://app.example")).toEqual({ origin: "https://app.example" })
    expect(resolveCorsFlag("  https://app.example/page  ")).toEqual({ origin: "https://app.example/page" })
  })

  it("rejects values that are neither '*' nor an http(s) origin", () => {
    expect(() => resolveCorsFlag("app.example")).toThrow(/--cors/)
    expect(() => resolveCorsFlag("ftp://x")).toThrow(/--cors/)
  })
})

describe("dashboard directory resolution", () => {
  it("walks up from a built dist directory to apps/dashboard", () => {
    const root = tempDir()
    const dist = join(root, "packages", "mik", "dist")
    const app = join(root, "apps", "dashboard")
    mkdirSync(dist, { recursive: true })
    mkdirSync(app, { recursive: true })
    expect(walkUpFor(dist, join("apps", "dashboard"))).toBe(app)
  })

  it("falls back to the CLI's own location when the cwd is outside the monorepo", () => {
    expect(findDashboardDir(tmpdir())).toMatch(/apps[\\/]dashboard$/)
  })

  it("returns null when neither the cwd nor the module directory has the app", () => {
    const root = tempDir()
    expect(findDashboardDir(root, root)).toBeNull()
  })

  /**
   * The dashboard is not in the published tarball, so the CLI must explain that
   * instead of printing a bare "could not find" (F11 / review B3).
   */
  it("explains that the dashboard is not part of the published package", async () => {
    const { dir } = sandbox()
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))

    const empty = tempDir()
    const result = await run(["dashboard", "--dir", empty, "--port", String(port)], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("no package.json")
    expect(result.stderr).toContain("not published with the npm package")
    expect(result.stderr).toContain("README")
    expect(result.stderr).toContain("--dir")
  })

  it("uses the same guidance when the dashboard app cannot be found at all", () => {
    const error = missingDashboardError()
    expect(error.message).toContain("Could not find the dashboard app")
    expect(error.message).toContain("not published with the npm package")
    expect(error.message).toContain("pnpm --filter @mik/dashboard")
    expect(error.message).toContain("README")
  })
})

/**
 * EVO-G09 / audit-reliability P2-2. The dashboard launcher used to pass
 * `shell: !useLocalNext && process.platform === "win32"` on Windows; the option is
 * gone, so the assertion below is on the *absence of the key*, not on a literal
 * `true` (which was already unreachable in the default branch and caught nothing).
 */
describe("dashboard launch is shell-free", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "commands", "dashboard.ts"),
    "utf8",
  )

  it("never hands the dashboard command line to a shell", () => {
    expect(source).not.toMatch(/shell\s*:/)
  })

  it("launches node itself, with the resolved entry point as an argument", () => {
    expect(source).toContain("command = process.execPath")
    expect(source).toContain("findPnpmScript(process.env)")
    expect(source).toMatch(/args = \[pnpmScript, "exec", "next", "start", "-p", String\(port\)\]/)
  })

  it("resolves pnpm's JavaScript entry point rather than its .cmd shim", () => {
    const root = tempDir()
    mkdirSync(join(root, "node_modules", "pnpm", "bin"), { recursive: true })
    writeFileSync(join(root, "pnpm"), "")
    writeFileSync(join(root, "node_modules", "pnpm", "bin", "pnpm.mjs"), "")

    expect(findPnpmScript({ PATH: root })).toBe(join(root, "node_modules", "pnpm", "bin", "pnpm.mjs"))
  })

  it("prefers the pnpm that launched the CLI when it is a JavaScript entry point", () => {
    const root = tempDir()
    const execPath = join(root, "pnpm.cjs")
    writeFileSync(execPath, "")
    expect(findPnpmScript({ npm_execpath: execPath, PATH: "" })).toBe(execPath)
  })

  it("returns null instead of throwing when pnpm is nowhere to be found", () => {
    expect(findPnpmScript({ PATH: "" })).toBeNull()
    // A `.cmd`/`.bat` shim is not something we can spawn, so it must not win.
    const root = tempDir()
    writeFileSync(join(root, "pnpm.cmd"), "")
    expect(findPnpmScript({ npm_execpath: join(root, "pnpm.cmd"), PATH: root })).toBeNull()
  })

  it("finds pnpm on this machine, which is what the real `mik dashboard` smoke run needs", () => {
    expect(findPnpmScript(process.env)).toMatch(/pnpm\.(?:mjs|cjs|js)$/)
  })
})

describe("pricing", () => {
  it("sets and lists a manual override with four-decimal money", async () => {
    const { dir, base } = sandbox()
    const set = await run(["pricing", "set", "deepseek-chat", "--input", "0.27", "--output", "1.1", ...base], dir)
    expect(set.code).toBe(0)
    expect(set.stdout).toContain("0.2700")
    expect(set.stdout).toContain("1.1000")

    const list = await run(["pricing", "list", ...base], dir)
    expect(list.code).toBe(0)
    expect(list.stdout).toContain("deepseek-chat")
    expect(list.stdout).toContain("0.2700")
  })

  it("requires at least one rate", async () => {
    const { dir, base } = sandbox()
    const result = await run(["pricing", "set", "deepseek-chat", ...base], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/--input/)
  })

  it("refuses to sync while offline", async () => {
    const { dir, base } = sandbox()
    const result = await run(["pricing", "sync", ...base], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--offline")
  })
})

describe("usage", () => {
  /** The seeded events belong to `cli-app`, so every query names it explicitly. */
  const APP = ["--app-id", "cli-app"]

  async function seed(dbPath: string, appId = "cli-app"): Promise<void> {
    const store = await Store.open({ path: dbPath })
    const usage = new UsageService({ store, appId, enabled: true })
    usage.record({
      requestId: "r-1",
      ts: Date.parse("2026-09-01T10:00:00.000Z"),
      source: "generate",
      providerId: "deepseek",
      modelRequested: "deepseek:deepseek-chat",
      modelActual: "deepseek-chat",
      usage: { input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 },
      cost: { usd: 0.012345, low: 0.01, high: 0.02, basis: "flat", source: "modelsdev" },
      latencyMs: 850,
      status: "ok",
      isStreaming: false,
    })
    usage.record({
      requestId: "r-2",
      ts: Date.parse("2026-09-02T11:00:00.000Z"),
      source: "fetch",
      providerId: "openai",
      modelRequested: "openai:gpt-4o",
      modelActual: "gpt-4o",
      usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usd: 1.5, low: 1.5, high: 1.5, basis: "flat", source: "missing" },
      latencyMs: 1200,
      status: "error",
      errorCode: "RATE_LIMIT",
      isStreaming: false,
    })
    store.close()
  }

  it("summarises with thousands separators and four-decimal money", async () => {
    const { dir, db, base } = sandbox()
    await seed(db)
    const result = await run(["usage", "summary", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Requests        2")
    expect(result.stdout).toContain("Input tokens    3,200")
    expect(result.stdout).toContain("Cost (USD)      1.5123")
  })

  it("filters by app id", async () => {
    const { dir, db, base } = sandbox()
    await seed(db)
    const result = await run(["usage", "summary", "--app", "someone-else", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Requests")
    expect(result.stdout).not.toContain("1,200")
  })

  it("lists recent requests", async () => {
    const { dir, db, base } = sandbox()
    await seed(db)
    const result = await run(["usage", "logs", "--limit", "5", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("deepseek-chat")
    expect(result.stdout).toContain("gpt-4o")
    expect(result.stdout).toContain("Showing 2 of 2")
  })

  it("trends per day with a total row", async () => {
    const { dir, db, base } = sandbox()
    await seed(db)
    const result = await run(["usage", "trends", "--days", "30", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("TOTAL")
  })

  it("exports CSV with the fixed header", async () => {
    const { dir, db, base } = sandbox()
    await seed(db)
    const result = await run(["usage", "export", "--format", "csv", ...base, ...APP], dir)
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split("\n")
    expect(lines[0]).toBe(USAGE_CSV_HEADER)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(
      "2026-09-01T10:00:00.000Z,cli-app,deepseek,deepseek-chat,ok,1200,300,800,0,64,0.0123,modelsdev,flat,850",
    )
    expect(lines[2]).toContain(",openai,gpt-4o,error,2000,500,0,0,0,1.5000,missing,flat,1200")
  })

  it("writes the CSV to --out", async () => {
    const { dir, db, base } = sandbox()
    await seed(db)
    const target = join(dir, "out", "usage.csv")
    const result = await run(["usage", "export", "--format", "csv", "--out", target, ...base, ...APP], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Wrote 2 row(s)")
    const written = readFileSync(target, "utf8")
    expect(written.split("\n")[0]).toBe(USAGE_CSV_HEADER)
    expect(written.trimEnd().split("\n")).toHaveLength(3)
  })

  it("rejects an unsupported export format", async () => {
    const { dir, base } = sandbox()
    const result = await run(["usage", "export", "--format", "json", ...base], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("csv")
  })

  it("rejects a malformed date", async () => {
    const { dir, base } = sandbox()
    const result = await run(["usage", "summary", "--from", "not-a-date", ...base], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("--from")
  })

  it("rejects an invalid status filter", async () => {
    const { dir, base } = sandbox()
    const result = await run(["usage", "logs", "--status", "weird", ...base], dir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("ok")
  })
})

describe("models", () => {
  it("explains an empty catalogue instead of failing", async () => {
    const { dir, base } = sandbox()
    const result = await run(["models", ...base], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("No models stored yet")
    expect(result.stdout).toContain("mik models --refresh")
  })

  it("refuses to refresh while offline", async () => {
    const { dir, base } = sandbox()
    const result = await run(["models", "--refresh", ...base], dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--offline")
  })
})

describe("catalogue sync scope (F08)", () => {
  /** A local stand-in for a provider's `/v1/models`, counting the requests. */
  async function fakeProvider(): Promise<{ baseUrl: string; hits: () => number; stop: () => Promise<void> }> {
    let hits = 0
    const server = createHttpServer((_request, response) => {
      hits += 1
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "f08-model", object: "model", created: 1, owned_by: "f08" }] }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    return {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      hits: () => hits,
      stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  /** Flags that pin a run to one temp database, so two calls see the same data. */
  function flags(dir: string): string[] {
    return ["--db", join(dir, "usage.db"), "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json")]
  }

  /**
   * A `file:` credential ref with a real secret behind it. `env:` refs read
   * `process.env`, which the CLI's own `env` option does not touch, so a file
   * keeps the test hermetic.
   */
  function secretRef(dir: string, id: string): string {
    const path = join(dir, `${id}-api-key`)
    writeFileSync(path, "sk-f08-cli-secret", "utf8")
    return `file:${path}`
  }

  /**
   * Open a CLI context without `--offline` (so the catalogue sync is governed by
   * the command itself) while keeping the price catalogue off the network.
   */
  async function openFor(args: string[], dir: string, hub: Partial<ModelInfraOptions> = {}) {
    const warnings: string[] = []
    const context = await openContext(parseCliArgs(args), {
      cwd: dir,
      env: { ...process.env },
      io: { out: () => {}, err: (text) => warnings.push(text) },
      hub: { pricingFetch: offlineFetch, ...hub },
    })
    return { context, warnings }
  }

  /** The offline price catalogue warns by construction; it is not the noise under test. */
  function hostWarnings(warnings: readonly string[]): string[] {
    return warnings.filter((message) => !message.includes("modelsdev"))
  }

  async function addProvider(dir: string, id: string, baseUrl: string, keyRef: string) {
    return run(["provider", "add", id, "--base-url", baseUrl, "--api-key-ref", keyRef, "--offline", ...flags(dir)], dir)
  }

  it("does not sync the catalogue for a read-only command", async () => {
    const provider = await fakeProvider()
    const dir = tempDir()
    try {
      expect((await addProvider(dir, "local", provider.baseUrl, secretRef(dir, "local"))).code).toBe(0)

      const { context, warnings } = await openFor(["provider", "list", ...flags(dir)], dir)
      await context.hub.catalogSync
      expect(context.hub.providers.list().map((record) => record.id)).toEqual(["local"])
      expect(context.hub.models.list()).toEqual([])
      await context.close()

      expect(provider.hits()).toBe(0)
      expect(hostWarnings(warnings)).toEqual([])
    } finally {
      await provider.stop()
    }
  })

  it("syncs the catalogue for the commands that need it", async () => {
    const provider = await fakeProvider()
    const dir = tempDir()
    try {
      expect((await addProvider(dir, "local", provider.baseUrl, secretRef(dir, "local"))).code).toBe(0)

      const { context } = await openFor(["models", "--refresh", ...flags(dir)], dir)
      await context.hub.catalogSync
      await context.close()

      expect(provider.hits()).toBeGreaterThan(0)
    } finally {
      await provider.stop()
    }
  })

  it("stays silent about a missing credential but still warns about a real failure", async () => {
    const dir = tempDir()
    // No credential anywhere for this provider: the expected state right after
    // `provider add`, which must never reach the user as a warning.
    expect((await addProvider(dir, "local", "http://127.0.0.1:9/v1", "env:MIK_F08_ABSENT")).code).toBe(0)

    const readOnly = await openFor(["provider", "list", ...flags(dir)], dir)
    await readOnly.context.hub.catalogSync
    await readOnly.context.close()
    expect(hostWarnings(readOnly.warnings)).toEqual([])

    const syncing = await openFor(["models", "--refresh", ...flags(dir)], dir)
    await syncing.context.hub.catalogSync
    await syncing.context.close()
    expect(hostWarnings(syncing.warnings)).toEqual([])

    // A provider with a usable key and an unreachable endpoint is a real
    // failure and must still be reported.
    expect((await addProvider(dir, "dead", "http://127.0.0.1:9/v1", secretRef(dir, "dead"))).code).toBe(0)
    const failing = await openFor(["models", "--refresh", ...flags(dir)], dir)
    await failing.context.hub.catalogSync
    await failing.context.close()
    expect(failing.warnings.join("\n")).toContain("dead")
  })
})
