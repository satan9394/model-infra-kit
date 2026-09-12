import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { COMMANDS, parseCliArgs } from "../src/cli/args.js"
import { openContext, offlineFetch } from "../src/cli/context.js"
import { USAGE_CSV_COLUMNS, USAGE_CSV_FROZEN_COLUMNS, USAGE_CSV_FROZEN_HEADER, USAGE_CSV_HEADER, usageCsv, usageCsvRow } from "../src/cli/csv.js"
import { formatMoney, formatTable, formatTokens } from "../src/cli/format.js"
import { isDirectInvocation, main } from "../src/cli/index.js"
import { netstatShowsPort, portInUse } from "../src/cli/ports.js"
import { CliUsageError } from "../src/cli/errors.js"
import { findDashboardDir, findPnpmScript, missingDashboardError, walkUpFor } from "../src/cli/commands/dashboard.js"
import { loadServerModule, resolveCorsFlag, resolveServerModuleUrl, serverModuleCandidates } from "../src/cli/commands/serve.js"
import { setPackageResolver } from "../src/cli/packages.js"
import { ModelInfra } from "../src/hub.js"
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

/**
 * Run the CLI in-process with captured streams. Every call is offline by construction.
 *
 * `MIK_LANG` defaults to `en` so the assertions below never depend on the machine's
 * OS locale (a zh-CN host would otherwise render Chinese and flip these tests); a
 * test that wants another language passes it in `env`.
 */
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
    // EVO-G75 appended `tags` (15th). EVO-G81 appended seven traceability
    // columns after it. Appending is the only change a host script can absorb:
    // the fifteen pre-change names keep their exact positions, and **both**
    // frozen prefixes are asserted as literals rather than against
    // `USAGE_CSV_HEADER` (which would compare the constant with itself).
    expect(USAGE_CSV_HEADER).toBe(
      "ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms,tags,request_id,session_id,first_token_ms,is_streaming,error_code,pricing_model,cost_microusd",
    )
    // EVO-G81: the frozen 15-name prefix, byte-for-byte, as a literal.
    expect(USAGE_CSV_FROZEN_HEADER).toBe(
      "ts,app_id,provider,model,status,input,output,cache_read,cache_write,reasoning,cost_usd,pricing_source,pricing_basis,latency_ms,tags",
    )
    expect(USAGE_CSV_FROZEN_COLUMNS).toHaveLength(15)
    expect(USAGE_CSV_HEADER.startsWith(USAGE_CSV_FROZEN_HEADER)).toBe(true)
    expect(USAGE_CSV_HEADER.split(",")).toHaveLength(22)
    expect(USAGE_CSV_HEADER.split(",").slice(0, 14)).toEqual([
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
  })

  it("renders one row per event, oldest first", () => {
    const csv = usageCsv([{ ...event, requestId: "r-2", ts: event.ts + 1000 }, event])
    const lines = csv.trimEnd().split("\n")
    expect(lines[0]).toBe(USAGE_CSV_HEADER)
    expect(lines).toHaveLength(3)
    // EVO-G75: the pre-change fields keep their exact positions; only the
    // appended `tags` field is empty here (the fixture carries no tags).
    // EVO-G81 changes two things in this row and nothing else:
    //  - `cost_usd` is the exact 6-decimal micro-USD rendering (0.012345), not
    //    the old 4-decimal 0.0123 that made the row sum disagree with the total;
    //  - the seven appended columns: request_id `r-1`, then session/TTFT/error/
    //    pricing_model empty, `is_streaming` false, and the integer micros 12345.
    expect(lines[1]).toBe(
      "2026-09-01T10:00:00.000Z,cli-app,deepseek,deepseek-chat,ok,1200,300,800,0,64,0.012345,modelsdev,flat,850,,r-1,,,false,,,12345",
    )
    expect(lines[2]?.startsWith("2026-09-01T10:00:01.000Z")).toBe(true)
  })

  it("quotes fields that contain a comma or a quote", () => {
    const row = usageCsvRow({ ...event, modelActual: 'weird,"model"' })
    expect(row).toContain('"weird,""model"""')
  })

  it("leaves a missing latency empty rather than writing null", () => {
    const fields = usageCsvRow({ ...event, latencyMs: undefined }).split(",")
    expect(fields).toHaveLength(USAGE_CSV_COLUMNS.length)
    // `latency_ms` keeps index 13 and stays empty; the appended `tags` is 14.
    expect(USAGE_CSV_COLUMNS.indexOf("latency_ms")).toBe(13)
    expect(fields[13]).toBe("")
    expect(fields[14]).toBe("")
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

  it("localizes root help into Chinese under MIK_LANG=zh", async () => {
    const { dir } = sandbox()
    const result = await run(["--help"], dir, { MIK_LANG: "zh" })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("可嵌入的模型层")
    expect(result.stdout).toContain("用法")
    expect(result.stdout).not.toContain("Embeddable model layer")
    // Command names stay literal so they remain copy-pasteable.
    expect(result.stdout).toContain("mik provider")
  })

  it("localizes an unknown command into Chinese and keeps exit code 2", async () => {
    const { dir } = sandbox()
    const result = await run(["no-such-cmd"], dir, { MIK_LANG: "zh" })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("未知命令")
    expect(result.stderr).not.toContain("Unknown command")
  })

  it("localizes a missing positional argument into Chinese and keeps exit code 2", async () => {
    const { dir } = sandbox()
    const result = await run(["provider", "remove"], dir, { MIK_LANG: "zh" })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("缺少必需参数")
  })

  it("keeps the English output in English under MIK_LANG=en (A2)", async () => {
    const { dir } = sandbox()
    const result = await run(["--help"], dir, { MIK_LANG: "en" })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Embeddable model layer")
    expect(result.stdout).toContain("USAGE")
    expect(result.stdout).not.toContain("可嵌入的模型层")
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

  it("warns again instead of silently defaulting when the retry is bogus too (EVO-G11/G15)", async () => {
    const { dir, base } = sandbox()
    const configPath = join(dir, "mik.config.json")
    const stderr: string[] = []
    promptMock.prompt.mockReset()
    promptMock.prompt
      .mockResolvedValueOnce("garbage") // invalid → wizard.langInvalid + retry
      .mockResolvedValueOnce("still-garbage") // invalid again → hint once more, then default
      .mockResolvedValueOnce("") // appId (default)
      .mockResolvedValueOnce("") // db (default)
      .mockResolvedValueOnce("") // provider (skip)

    const result = await main(
      ["init", "--file", configPath, ...base],
      { io: { out: () => {}, err: (text) => stderr.push(text) }, cwd: dir, env: { ...process.env, LC_ALL: "zh_CN.UTF-8" }, interactive: true },
    )
    expect(result).toBe(0)
    // Two prompts, two hints — the second bogus answer is no longer silent.
    const hints = stderr.filter((line) => line.includes("请输入 1 或 2"))
    expect(hints).toHaveLength(2)
    const questions = promptMock.prompt.mock.calls.map((call) => String(call[0]))
    expect(questions).toHaveLength(5)
    // Both bogus answers leave the locale-derived default (zh) in place.
    expect(questions[0]).toContain("Choose a language")
    expect(questions[1]).toContain("Choose a language")
    expect(questions[2]).toContain("应用 id")
    expect(questions[3]).toContain("数据库")
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
    // EVO-G69: the lookup reads the *resolved* environment (`resolveEnv(options)`,
    // i.e. `options.env ?? process.env`) instead of the real `process.env`, so an
    // injected environment decides where pnpm is found — the EVO-G12 rule that an
    // injectable entry point must never fall back to the host environment. In a
    // real CLI run `env` *is* `process.env`, so nothing changes for users.
    expect(source).toContain("findPnpmScript(env)")
    expect(source).not.toContain("findPnpmScript(process.env)")
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
    // EVO-G78: r-2 has `source: "missing"`, so one of the two requests has no
    // price and the recorded total is only a floor — named, with the count.
    // The floor is `costLowUsd`: r-1's own estimate spans 0.01 – 0.02, so its
    // point value (0.012345) is *not* a proven lower bound of the true total.
    // Hand-computed: low = 0.0100 + 1.5000 = 1.5100.
    expect(result.stdout).toContain("Cost (USD)      at least 1.5100")
    expect(result.stdout).toContain("Cost range      at least 1.5100 (upper bound unknown: 1 request(s) unpriced)")
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
      "2026-09-01T10:00:00.000Z,cli-app,deepseek,deepseek-chat,ok,1200,300,800,0,64,0.012345,modelsdev,flat,850,,r-1,,,false,,deepseek-chat,12345",
    )
    // EVO-G81: exact micro-USD money, and the seven appended traceability
    // columns. The second row is an error with no tag; `pricing_model` defaults
    // to `model_actual` on insert (`usage-repository.ts:231`).
    expect(lines[2]).toContain(",openai,gpt-4o,error,2000,500,0,0,0,1.500000,missing,flat,1200,,r-2,,,false,RATE_LIMIT,gpt-4o,1500000")
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

// ---------------------------------------------------------------------------
// EVO-G13 — `provider …` / `usage …` output localization
// ---------------------------------------------------------------------------

describe("subcommand i18n (EVO-G13)", () => {
  /** Every case injects MIK_LANG through `run()`; nothing reads the host locale. */
  const ZH = { MIK_LANG: "zh" }
  const EN = { MIK_LANG: "en" }

  /**
   * The frozen pre-change English baselines, byte-for-byte (`.tmp/baseline-g13-*`
   * captured from the 0.2.8 build; the trailing `\n` is what the CLI emits).
   * Hardcoded here so the regression gate travels with the repo instead of with
   * the gitignored `.tmp/` directory (technical debt G47).
   */
  const EN_PROVIDER_LIST =
    "No providers configured.\n\nAdd one with:\n" +
    "  mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY\n" +
    "  mik provider list\n"
  const EN_PROVIDER_HELP =
    "mik provider — List, add, remove and test providers\n\n" +
    "USAGE\n  mik provider <list|add|remove|test> [options]\n\n" +
    "ACTIONS\n  list    List configured providers and the default model\n" +
    "  add     Add or update a provider (preset fills protocol, base URL and env var)\n" +
    "  remove  Remove a provider from the database\n" +
    "  test    Probe a provider with one minimal call\n\n" +
    "GLOBAL OPTIONS\n" +
    "      --db <path>         SQLite database file (default ~/.model-infra-kit/usage.db)\n" +
    "      --app-id <id>       Owning application id (default: default)\n" +
    "      --config <path>     CLI config file (default ./mik.config.json)\n" +
    "      --cache-dir <path>  Pricing catalogue cache directory\n" +
    "      --offline           Never touch the network (skip catalogue sync and provider probes)\n" +
    "  -h, --help              Show help\n" +
    "  -v, --version           Show version\n"
  const EN_USAGE_SUMMARY_EMPTY =
    "Range all time (no --from/--to given) · app=default\n" +
    "Note: with no --from/--to this command covers the whole history; usage trends covers only the last 30 days by default.\n\n" +
    "Requests        0\n" +
    "Successes       0\n" +
    "Failures        0\n" +
    "Success rate    0.0%\n" +
    "Cost (USD)      0.0000\n" +
    "Cost range      0.0000 – 0.0000\n" +
    "Input tokens    0\n" +
    "Output tokens   0\n" +
    "Cache read      0\n" +
    "Cache write     0\n" +
    "Reasoning       0\n" +
    "Cache hit rate  0.0%\n" +
    "Avg latency     -\n" +
    // EVO-G82 / audit-R232 F3: an empty range measured nothing, so this is `-`.
    // The pre-change value was `0 ms` on both lines — the defect the card fixes.
    "First token     -\n"
  const EN_USAGE_LOGS_EMPTY =
    "Range all time (no --from/--to given) · app=default\n" +
    "Note: with no --from/--to this command covers the whole history; usage trends covers only the last 30 days by default.\n\n" +
    "No usage recorded in this range.\n"

  /** Framework prose that must never survive on the zh surface. */
  const ENGLISH_FRAMEWORK_WORDS = [
    "Requests",
    "Successes",
    "Failures",
    "Success rate",
    "Cost (USD)",
    "Input tokens",
    "No usage recorded",
    "No providers configured",
    "Add one with",
    "Default model:",
    "Refusing to remove",
    "Aborted",
    "Remove provider",
    "Showing ",
    "UNKNOWN",
  ]

  function noEnglishProse(stdout: string): void {
    for (const word of ENGLISH_FRAMEWORK_WORDS) {
      expect(stdout, `zh output leaked "${word}"`).not.toContain(word)
    }
  }

  /** One `cli-app` event: enough to exercise every label and value path. */
  async function seedUsageEvent(dbPath: string): Promise<void> {
    const store = await Store.open({ path: dbPath })
    const usage = new UsageService({ store, appId: "cli-app", enabled: true })
    usage.record({
      requestId: "g13-r-1",
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
    store.close()
  }

  it("A1 — localizes the provider list empty state and headers into Chinese", async () => {
    const { dir, base } = sandbox()
    const empty = await run(["provider", "list", ...base], dir, ZH)
    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain("还没有配置任何供应商。")
    expect(empty.stdout).toContain("添加一条：")
    // The example argv stays copy-pasteable.
    expect(empty.stdout).toContain("  mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY")
    noEnglishProse(empty.stdout)

    await run(["provider", "add", "deepseek", "--preset", "deepseek", "--api-key-ref", "env:DEEPSEEK_API_KEY", ...base], dir, ZH)
    const listed = await run(["provider", "list", ...base], dir, ZH)
    expect(listed.code).toBe(0)
    for (const header of ["供应商", "名称", "协议", "接口地址", "密钥引用", "启用", "默认"]) {
      expect(listed.stdout, header).toContain(header)
    }
    expect(listed.stdout).toContain("默认模型：")
    expect(listed.stdout).toContain("数据库：")
    // Data values are untouched and still copy-pasteable.
    expect(listed.stdout).toContain("deepseek")
    expect(listed.stdout).toContain("https://api.deepseek.com/v1")
    expect(listed.stdout).toContain("env:DEEPSEEK_API_KEY")
    noEnglishProse(listed.stdout)
  })

  it("A2 — keeps the English provider list and help byte-for-byte", async () => {
    const { dir, base } = sandbox()
    const list = await run(["provider", "list", ...base], dir, EN)
    expect(list.code).toBe(0)
    expect(`${list.stdout}\n`).toBe(EN_PROVIDER_LIST)

    const help = await run(["provider", "--help"], dir, EN)
    expect(help.code).toBe(0)
    expect(`${help.stdout}\n`).toBe(EN_PROVIDER_HELP)
    expect(`${help.stdout}\n`).not.toContain("供应商")
  })

  it("A1 — localizes the provider add notice, success and next-step lines", async () => {
    const { dir, base } = sandbox()
    const result = await run(["provider", "add", "deepseek", "--preset", "deepseek", ...base], dir, ZH)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("提示：未提供 --api-key-ref")
    expect(result.stdout).toContain("DEEPSEEK_API_KEY")
    expect(result.stdout).toContain("已添加供应商「deepseek」。")
    expect(result.stdout).toContain("更新时间：")
    expect(result.stdout).toContain("验证：mik provider test deepseek")
    noEnglishProse(result.stdout)
  })

  it("A1 — localizes provider error paths and keeps their exit codes", async () => {
    const { dir, base } = sandbox()
    // Runtime error (exit 1): the provider is not configured.
    const missing = await run(["provider", "remove", "ghost", ...base], dir, ZH)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("供应商「ghost」未配置。")
    expect(missing.stderr).not.toContain("is not configured")

    // Offline refusal (exit 1) for the card's `provider test <unknown>` shape.
    const test = await run(["provider", "test", "no-such-provider", "--offline", ...base], dir, ZH)
    expect(test.code).toBe(1)
    expect(test.stderr).toContain("需要网络访问")

    // Usage error (exit 2): an unknown protocol.
    const protocol = await run(["provider", "add", "x", "--protocol", "bogus", ...base], dir, ZH)
    expect(protocol.code).toBe(2)
    expect(protocol.stderr).toContain("未知协议「bogus」。")
    expect(protocol.stderr).toContain("用法：")
  })

  it("A1 — localizes the usage summary labels and keeps the value column aligned", async () => {
    const { dir, db, base } = sandbox()
    await seedUsageEvent(db)
    const result = await run(["usage", "summary", "--app-id", "cli-app", ...base], dir, ZH)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("区间 ")
    // `app=` stays a literal key name so the filter can be copied back.
    expect(result.stdout).toContain("· app=cli-app")
    for (const label of ["请求数", "成功数", "失败数", "成功率", "成本 (USD)", "成本区间", "平均延迟", "首 token 延迟"]) {
      expect(result.stdout, label).toContain(label)
    }
    // Data values keep their exact formatting. The seeded event records a *band*
    // (usd 0.012345, low 0.01, high 0.02 — `seedUsageEvent` below), and EVO-G89
    // made `usage summary` render the recorded band instead of the deprecated
    // point estimate, so the cost cell is a four-decimal pair. The point estimate
    // is deliberately gone from this surface: it is the one member of the triple
    // that is not an endpoint, and the CLI no longer reads `costUsd` at all. The
    // per-row value is still on `usage logs` and in `usage export`.
    expect(result.stdout).toContain("0.0100 – 0.0200")
    expect(result.stdout).not.toContain("0.012345")
    // CJK labels are padded by display width: the widest label (首 token 延迟,
    // 13 columns) + the two-space gutter puts every value in column 15. Naive
    // `.length` padding would leave 请求数 five spaces short.
    expect(result.stdout).toContain(`${"请求数"}${" ".repeat(9)}1`)
    noEnglishProse(result.stdout)
  })

  it("A2 — keeps the English usage summary and logs byte-for-byte", async () => {
    const { dir, base } = sandbox()
    const summary = await run(["usage", "summary", ...base], dir, EN)
    expect(summary.code).toBe(0)
    expect(`${summary.stdout}\n`).toBe(EN_USAGE_SUMMARY_EMPTY)

    const logs = await run(["usage", "logs", ...base], dir, EN)
    expect(logs.code).toBe(0)
    expect(`${logs.stdout}\n`).toBe(EN_USAGE_LOGS_EMPTY)

    const { dir: seededDir, db, base: seededBase } = sandbox()
    await seedUsageEvent(db)
    const showing = await run(["usage", "logs", "--app-id", "cli-app", ...seededBase], seededDir, EN)
    expect(showing.code).toBe(0)
    expect(showing.stdout).toContain("Showing 1 of 1 event(s) (offset 0).")
    expect(showing.stdout).toContain("LATENCY")
    expect(showing.stdout).toContain("COST USD")
  })

  it("A3 — keeps the script-facing export output identical under zh", async () => {
    const { dir, db, base } = sandbox()
    await seedUsageEvent(db)
    const args = ["usage", "export", "--format", "csv", "--app-id", "cli-app", ...base]
    const en = await run(args, dir, EN)
    const zh = await run(args, dir, ZH)
    expect(zh.code).toBe(0)
    // The CSV is a data format: byte-identical in both languages, fixed header.
    expect(zh.stdout).toBe(en.stdout)
    expect(zh.stdout.split("\n")[0]).toBe(USAGE_CSV_HEADER)

    // ...while the human line next to `--out` is localized.
    const target = join(dir, "out", "usage.csv")
    const wrote = await run([...args, "--out", target], dir, ZH)
    expect(wrote.code).toBe(0)
    expect(wrote.stdout).toContain("已写入 1 行到")
    expect(readFileSync(target, "utf8").split("\n")[0]).toBe(USAGE_CSV_HEADER)
  })

  it("A1 — localizes the empty state for logs and trends", async () => {
    const { dir, base } = sandbox()
    const logs = await run(["usage", "logs", ...base], dir, ZH)
    expect(logs.code).toBe(0)
    expect(logs.stdout).toContain("该区间没有用量记录。")
    noEnglishProse(logs.stdout)

    const trends = await run(["usage", "trends", "--days", "7", ...base], dir, ZH)
    expect(trends.code).toBe(0)
    expect(trends.stdout).toContain("该区间没有用量记录。")
    noEnglishProse(trends.stdout)
  })

  it("A1/A5 — localizes usage flag errors, keeping the flag names literal and exit code 2", async () => {
    const { dir, base } = sandbox()
    const limit = await run(["usage", "logs", "--limit", "0", ...base], dir, ZH)
    expect(limit.code).toBe(2)
    expect(limit.stderr).toContain("--limit 必须是 1 到 1000 之间的整数")
    expect(limit.stderr).toContain("错误：")
    expect(limit.stderr).not.toContain("must be an integer")

    const range = await run(["usage", "summary", "--from", "not-a-date", ...base], dir, ZH)
    expect(range.code).toBe(2)
    expect(range.stderr).toContain("--from 需要 YYYY-MM-DD")
  })

  it("A3 — localizes the zh trends/logs table headers without touching the data", async () => {
    const { dir, db, base } = sandbox()
    await seedUsageEvent(db)
    const logs = await run(["usage", "logs", "--app-id", "cli-app", ...base], dir, ZH)
    expect(logs.code).toBe(0)
    for (const header of ["时间", "应用", "供应商", "模型", "状态", "输入", "输出", "成本 USD", "延迟"]) {
      expect(logs.stdout, header).toContain(header)
    }
    // Row data (ids, model, status) stays literal; the timestamp column is local
    // time, so it is deliberately not pinned to a literal here.
    expect(logs.stdout).toContain("cli-app")
    expect(logs.stdout).toContain("deepseek-chat")
    expect(logs.stdout).toContain("ok")
    expect(logs.stdout).toContain("显示 1 / 1 条事件（offset 0）。")
    noEnglishProse(logs.stdout)
  })
})

describe("remaining CLI surface i18n (EVO-G14)", () => {
  /** Every case injects MIK_LANG through `run()`; nothing reads the host locale. */
  const ZH = { MIK_LANG: "zh" }
  const EN = { MIK_LANG: "en" }

  it("localizes the invalid-port error for `dashboard` (port checks were the last `throw` leftover)", async () => {
    const { dir, base } = sandbox()
    const zh = await run(["dashboard", "--port", "0", ...base], dir, ZH)
    expect(zh.code).toBe(1)
    expect(zh.stderr).toContain("端口 0 不合法")
    expect(zh.stderr).not.toContain("Invalid port")
  })

  it("localizes the invalid-port error for `serve` as well", async () => {
    const { dir, base } = sandbox()
    const zh = await run(["serve", "--port", "0", ...base], dir, ZH)
    expect(zh.code).toBe(1)
    expect(zh.stderr).toContain("端口 0 不合法")
    expect(zh.stderr).not.toContain("Invalid port")
  })

  it("keeps the invalid-port error in English under MIK_LANG=en (A2)", async () => {
    const { dir, base } = sandbox()
    const en = await run(["dashboard", "--port", "0", ...base], dir, EN)
    expect(en.code).toBe(1)
    expect(en.stderr).toContain("Invalid port 0. Use an integer between 1 and 65535.")
  })

  it("localizes the `models list` empty state", async () => {
    const { dir, base } = sandbox()
    const zh = await run(["models", "list", ...base], dir, ZH)
    expect(zh.code).toBe(0)
    expect(zh.stdout).toContain("还没有存储任何模型。")
    expect(zh.stdout).toContain("发现模型：")
    expect(zh.stdout).not.toContain("No models stored yet")
  })

  it("localizes the `pricing list` catalogue heading and its state labels", async () => {
    const { dir, base } = sandbox()
    const zh = await run(["pricing", "list", ...base], dir, ZH)
    expect(zh.code).toBe(0)
    expect(zh.stdout).toContain("价格目录")
    expect(zh.stdout).not.toContain("Catalogue")
    // The four field labels are prose and must be localized; the *values*
    // (`stale`/`fallback`, `modelsdev`) are data and stay literal.
    for (const label of ["状态", "来源", "载入", "错误"]) {
      expect(zh.stdout, label).toContain(label)
    }
    for (const leaked of ["status  ", "source  ", "loaded  ", "error   "]) {
      expect(zh.stdout, `zh leaked "${leaked}"`).not.toContain(leaked)
    }
  })

  it("localizes the `warning:` frame while leaving the third-party body alone", async () => {
    const { dir, base } = sandbox()
    // An unreadable config makes the CLI emit its own `warning:` line before any
    // command output. Only the frame is ours to translate (EVO-G14/R101).
    writeFileSync(join(dir, "mik.config.json"), "{ not json", "utf8")
    const zh = await run(["models", "list", ...base], dir, ZH)
    expect(zh.code).toBe(0)
    expect(zh.stderr).toContain("警告：")
    expect(zh.stderr).not.toContain("warning: ")
  })
})

// ---------------------------------------------------------------------------
// EVO-G15 — the first successful call path (G54 / G55 / G56 / G59 / G62)
// ---------------------------------------------------------------------------

describe("first-call path (EVO-G15)", () => {
  const ZH = { MIK_LANG: "zh" }
  const EN = { MIK_LANG: "en" }

  afterEach(() => {
    setPackageResolver(null)
  })

  /** The "optional peer is absent" world, without uninstalling anything. */
  const nothingInstalled = (): void => setPackageResolver(() => false)
  /** The "everything is installed" world, so the notice is provably silent. */
  const everythingInstalled = (): void => setPackageResolver(() => true)

  it("G54 — `provider add` names the exact install command when the protocol package is missing", async () => {
    const { dir, base } = sandbox()
    nothingInstalled()
    const result = await run(
      ["provider", "add", "gw", "--base-url", "http://127.0.0.1:9/v1", "--api-key-ref", "env:GW_KEY", ...base],
      dir,
      EN,
    )
    expect(result.code).toBe(0)
    // The package name comes from the single mapping in registry/presets.ts.
    expect(result.stdout).toContain("@ai-sdk/openai-compatible")
    expect(result.stdout).toContain("npm i @ai-sdk/openai-compatible")
  })

  it("G54 — prints the notice only when the package is missing (no banner noise)", async () => {
    // Positive control in the same test: without it the negative half would be
    // vacuously true and could never fail (G43).
    const missing = sandbox()
    nothingInstalled()
    const warned = await run(
      ["provider", "add", "gw", "--base-url", "http://127.0.0.1:9/v1", "--api-key-ref", "env:GW_KEY", ...missing.base],
      missing.dir,
      EN,
    )
    expect(warned.stdout).toContain("npm i @ai-sdk/openai-compatible")

    const present = sandbox()
    everythingInstalled()
    const quiet = await run(
      ["provider", "add", "gw", "--base-url", "http://127.0.0.1:9/v1", "--api-key-ref", "env:GW_KEY", ...present.base],
      present.dir,
      EN,
    )
    expect(quiet.code).toBe(0)
    expect(quiet.stdout).toContain('Added provider "gw".')
    expect(quiet.stdout).not.toContain("npm i @ai-sdk/")
  })

  it("G55 — `serve --help` describes the real default (no token → writes 401)", async () => {
    const { dir } = sandbox()
    const en = await run(["serve", "--help"], dir, EN)
    expect(en.code).toBe(0)
    expect(en.stdout).toContain("write endpoints")
    expect(en.stdout).toContain("401")
    expect(en.stdout).not.toContain("Require Authorization: Bearer <token> on the HTTP API\n")
  })

  it("G59 — `init --help` says that omitting --provider registers no provider", async () => {
    const { dir } = sandbox()
    const en = await run(["init", "--help"], dir, EN)
    expect(en.code).toBe(0)
    expect(en.stdout).toContain("Without --provider no provider is registered")
  })

  it("G59 — `init --yes` prints a numbered 1/2/3 path whose last step is a real call", async () => {
    const { dir, base } = sandbox()
    const result = await run(["init", "--yes", "--app-id", "g15", "--provider", "deepseek", ...base], dir, EN)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("  1. set DEEPSEEK_API_KEY")
    expect(result.stdout).toContain("  2. start the service")
    expect(result.stdout).toContain("  3. make the first call")
    expect(result.stdout).toContain("/v1/chat/completions")
    expect(result.stdout).toContain("GET /v1/models")
  })

  it("G59/G62 — the no-provider guide uses a placeholder plus the preset candidates, not a hardcoded deepseek", async () => {
    const { dir, base } = sandbox()
    const result = await run(
      ["init", "--yes", "--app-id", "g15", "--file", join(dir, "other.json"), ...base],
      dir,
      EN,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("mik provider add <id> --preset <presetId> --api-key-ref env:<ENV_VAR>")
    expect(result.stdout).toContain("(presets: ")
    expect(result.stdout).not.toContain("--preset deepseek")
  })

  it("G62 — the `--help` examples carry a copy-pasteable /v1/chat/completions call", async () => {
    const { dir } = sandbox()
    const en = await run(["--help"], dir, EN)
    expect(en.code).toBe(0)
    expect(en.stdout).toContain("/v1/chat/completions")
    expect(en.stdout).toContain("mik serve --token")
    expect(en.stdout).toContain("/v1/models")
    // The hardcoded `deepseek` examples are gone (G59/G62).
    expect(en.stdout).not.toContain("--preset deepseek")
  })

  it("G56 — the bare-model 400 points at `<provider>:<model>` and GET /v1/models", async () => {
    const { dir, db } = sandbox()
    const hub = await ModelInfra.init({
      appId: "g15",
      db,
      pricingFetch: offlineFetch,
      providers: [
        { id: "gw", presetId: "custom-openai-compatible", baseUrl: "http://127.0.0.1:9/v1", apiKeyRef: "env:GW_KEY" },
      ],
    })
    try {
      // No default model is configured, so the bare name cannot be routed.
      expect(() => hub.resolveModel("gpt-4o")).toThrowError(/<provider>:<model>/)
      expect(() => hub.resolveModel("gpt-4o")).toThrowError(/GET \/v1\/models/)
      expect(() => hub.resolveModel(undefined)).toThrowError(/GET \/v1\/models/)
      // The library-layer wording stays English (G50 boundary).
      expect(() => hub.resolveModel("gpt-4o")).toThrowError(/No default provider is configured/)
    } finally {
      await hub.close()
    }
  })

  it("A3 — `provider list` prints the configured default model", async () => {
    const { dir, db, base } = sandbox()
    const hub = await ModelInfra.init({
      appId: "g15",
      db,
      pricingFetch: offlineFetch,
      providers: [
        { id: "gw", presetId: "custom-openai-compatible", baseUrl: "http://127.0.0.1:9/v1", apiKeyRef: "env:GW_KEY" },
      ],
    })
    hub.providers.setDefaultModel("gw:gpt-4o")
    await hub.close()
    const listed = await run(["provider", "list", ...base], dir, EN)
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain("Default model: gw:gpt-4o")
  })

  /** A free loopback port, so parallel runs cannot collide. */
  async function freePort(): Promise<number> {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return port
  }

  /**
   * Run `mik serve` until its banner is complete, then stop it with the signal
   * `waitForShutdown` listens for.
   *
   * Vitest installs its own SIGINT handler, so those listeners are parked for
   * the duration and restored afterwards — a manual `process.emit("SIGINT")`
   * would otherwise reach them and tear down the worker. The loop also waits
   * for the CLI's own listener to appear before emitting, because emitting with
   * *no* listener would run Node's default action and kill the worker.
   */
  async function serveBanner(args: readonly string[], dir: string): Promise<Captured> {
    const out: string[] = []
    const err: string[] = []
    const parked = process.listeners("SIGINT")
    process.removeAllListeners("SIGINT")
    try {
      const done = main(args, {
        io: { out: (text) => out.push(text), err: (text) => err.push(text) },
        cwd: dir,
        env: { ...process.env, MIK_LANG: "en" },
        interactive: false,
      })
      const deadline = Date.now() + 20_000
      const ready = (): boolean =>
        out.some((line) => line.includes("Press Ctrl+C")) && process.listeners("SIGINT").length > 0
      while (!ready() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(ready(), "serve never reached its banner").toBe(true)
      process.emit("SIGINT")
      const code = await done
      return { code, stdout: out.join("\n"), stderr: err.join("\n") }
    } finally {
      for (const listener of parked) process.on("SIGINT", listener)
    }
  }

  it("G55 — the no-token banner says write endpoints are disabled and the server keeps running", async () => {
    const { dir, base } = sandbox()
    everythingInstalled()
    const port = await freePort()
    const result = await serveBanner(["serve", "--port", String(port), ...base], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Listening on")
    expect(result.stdout).toContain("Write endpoints disabled: set --token or MIK_SERVER_TOKEN to enable them.")
  })

  it("G54 — the serve banner warns about a missing provider package without blocking startup", async () => {
    const { dir, base } = sandbox()
    everythingInstalled()
    await run(
      ["provider", "add", "gw", "--base-url", "http://127.0.0.1:9/v1", "--api-key-ref", "env:GW_KEY", ...base],
      dir,
      EN,
    )
    const port = await freePort()
    nothingInstalled()
    const result = await serveBanner(["serve", "--port", String(port), ...base], dir)
    // Startup is not blocked: the banner is complete and the exit code is a clean 0.
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Listening on")
    expect(result.stdout).toContain(
      "warning: the provider package @ai-sdk/openai-compatible is missing — write endpoints will return 502. Install it with: npm i @ai-sdk/openai-compatible",
    )
  })

  it("A5 — the new G15 notices localize, and the install command stays literal", async () => {
    const { dir, base } = sandbox()
    nothingInstalled()
    const zh = await run(
      ["provider", "add", "gw", "--base-url", "http://127.0.0.1:9/v1", "--api-key-ref", "env:GW_KEY", ...base],
      dir,
      ZH,
    )
    expect(zh.code).toBe(0)
    expect(zh.stdout).toContain("提示：该协议需要 @ai-sdk/openai-compatible")
    expect(zh.stdout).toContain("npm i @ai-sdk/openai-compatible")
    expect(zh.stdout).not.toContain("hint: this protocol needs")

    const { dir: dir2, base: base2 } = sandbox()
    nothingInstalled()
    const zhInit = await run(["init", "--yes", "--app-id", "g15", "--provider", "deepseek", ...base2], dir2, ZH)
    expect(zhInit.code).toBe(0)
    expect(zhInit.stdout).toContain("2. 起服务")
    expect(zhInit.stdout).toContain("3. 发出第一次调用")
  })
})
