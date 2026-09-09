import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { COMMANDS, parseCliArgs } from "../src/cli/args.js"
import { USAGE_CSV_HEADER, usageCsv, usageCsvRow } from "../src/cli/csv.js"
import { formatMoney, formatTable, formatTokens } from "../src/cli/format.js"
import { main } from "../src/cli/index.js"
import { netstatShowsPort, portInUse } from "../src/cli/ports.js"
import { CliUsageError } from "../src/cli/errors.js"
import { Store } from "../src/store/database.js"
import type { UsageEvent } from "../src/types.js"
import { UsageService } from "../src/usage/service.js"

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
