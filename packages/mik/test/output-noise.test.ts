import { spawnSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parseCliArgs } from "../src/cli/args.js"
import { providerTestMessage } from "../src/cli/commands/provider.js"
import { openContext, formatWarning } from "../src/cli/context.js"
import { main } from "../src/cli/index.js"
import { installWarningFilter, isSuppressedWarning } from "../src/cli/warning-filter.js"

/**
 * EVO-G70 — output noise (G60) and the `node:sqlite` experimental warning (G61).
 *
 * The card's rule for every claim is "count the occurrences", not "the old shape
 * is absent" (that would be the G43 vacuous assertion): A1 asserts the *same
 * sentence* is gone from the parenthetical **while the count of the variable name
 * stays 2**, A2 asserts the parenthetical still appears when the cause carries
 * information the body does not, and the G61 case asserts the targeted warning is
 * gone *and* that a different one still surfaces.
 *
 * Every language is injected (`MIK_LANG`), so nothing here depends on the host.
 */

const tempDirs: string[] = []
const servers: Server[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g70-"))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const server of servers) server.close()
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

interface Captured {
  code: number
  stdout: string
  stderr: string
}

/** The real library sentence for a missing credential ref (see `credential/store.ts`). */
const MISSING_KEY = "Environment variable NO_SUCH_VAR_X is not set for this provider's API key."

async function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, {
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    cwd,
    // `MIK_LANG` is always explicit: the OS locale must never decide this file's
    // expectations (a zh-CN host would otherwise flip the English case).
    env: { ...process.env, MIK_LANG: "zh", ...env },
    interactive: false,
  })
  return { code, stdout: out.join("\n"), stderr: err.join("\n") }
}

/** Count non-overlapping occurrences — the card's A1 instrument. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** An endpoint that answers every path with 401 (`unauthorizedServer` is never reached first). */
function unauthorizedServer(): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "invalid api key" } }))
    })
    servers.push(server)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

/** A temp dir holding one provider whose key ref names a variable that does not exist. */
async function seedProviderWithoutCredential(baseUrl: string): Promise<string> {
  const dir = tempDir()
  const added = await run(
    [
      "provider",
      "add",
      "probe2",
      "--protocol",
      "openai-compatible",
      "--base-url",
      baseUrl,
      "--api-key-ref",
      "env:NO_SUCH_VAR_X",
      "--db",
      join(dir, "usage.db"),
      "--config",
      join(dir, "mik.config.json"),
    ],
    dir,
  )
  expect(added.code, added.stderr).toBe(0)
  return dir
}

/** `provider test`'s flags for one seeded dir. */
function testArgs(dir: string): string[] {
  return ["provider", "test", "probe2", "--db", join(dir, "usage.db"), "--config", join(dir, "mik.config.json")]
}

// ---------------------------------------------------------------------------
// A1 — the summary line no longer prints the same sentence twice
// ---------------------------------------------------------------------------

describe("EVO-G70 — A1: zh `provider test` prints the cause once", () => {
  it("drops the parenthetical duplicate while keeping the variable name in both remaining spots", async () => {
    const dir = await seedProviderWithoutCredential(await unauthorizedServer())
    const result = await run(testArgs(dir), dir)

    // Failure still fails: exit code semantics are untouched (card §不能破坏什么).
    expect(result.code).toBe(1)

    // The summary line: the body still comes from the library, but the identical
    // sentence is no longer appended in parentheses.
    const warning = result.stderr.split("\n").filter((line) => line.includes("Provider check failed"))
    expect(warning).toHaveLength(1)
    const line = warning[0] ?? ""
    expect(line).toContain('警告： Provider check failed for "probe2"')
    expect(line).toContain(MISSING_KEY)
    expect(line).not.toContain(`(${MISSING_KEY})`)
    expect(occurrences(line, MISSING_KEY), line).toBe(1)

    // Whole-output count: summary once + table once = 2, down from 3. The table
    // cell is the localized short line, which still names the same variable.
    expect(occurrences(result.stderr + "\n" + result.stdout, "NO_SUCH_VAR_X")).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// A1 (cont.) — the table's `信息` column is a Chinese short line
// ---------------------------------------------------------------------------

describe("EVO-G70 — A1: zh table message column is localized", () => {
  it("renders 凭据缺失 with the verbatim environment variable name", async () => {
    const dir = await seedProviderWithoutCredential(await unauthorizedServer())
    const result = await run(testArgs(dir), dir)

    const rows = result.stdout.split("\n").filter((line) => line.startsWith("probe2"))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("failed")
    // Localized short line, variable name untouched…
    expect(rows[0]).toContain("凭据缺失：环境变量 NO_SUCH_VAR_X 未设置。")
    // …and the library's English sentence is gone from the table.
    expect(rows[0]).not.toContain(MISSING_KEY)
  })

  it("classifies every other failure shape into a Chinese short line, keeping data verbatim", () => {
    // en is the byte-identical path: the library sentence is passed through.
    expect(providerTestMessage(MISSING_KEY, "en")).toBe(MISSING_KEY)
    const auth = "API key rejected by the provider. Check the credential for this provider."
    expect(providerTestMessage(auth, "en")).toBe(auth)

    expect(providerTestMessage(MISSING_KEY, "zh")).toBe("凭据缺失：环境变量 NO_SUCH_VAR_X 未设置。")
    expect(providerTestMessage(auth, "zh")).toBe("鉴权被拒：该供应商拒绝了这把凭据。")
    expect(providerTestMessage("Could not reach the provider endpoint. Check the base URL and network.", "zh")).toBe(
      "连接失败：无法稳定连到该供应商端点。",
    )
    expect(providerTestMessage("The provider did not respond in time.", "zh")).toBe("连接失败：无法稳定连到该供应商端点。")
    expect(providerTestMessage("The provider does not recognise this model id.", "zh")).toBe(
      "模型不存在：该供应商不认识这个模型 id。",
    )
    expect(providerTestMessage("The provider package @ai-sdk/openai is not installed. Run: npm i @ai-sdk/openai", "zh")).toBe(
      "缺少依赖：@ai-sdk/openai 未安装，运行 npm i @ai-sdk/openai 后重试。",
    )
    // An unrecognised shape falls back to the original text — never a blank cell.
    const unknown = "Some brand new provider failure."
    expect(providerTestMessage(unknown, "zh")).toBe(unknown)
  })
})

// ---------------------------------------------------------------------------
// A2 — the reverse case: a cause that adds information must survive
// ---------------------------------------------------------------------------

describe("EVO-G70 — A2: a cause that is not already in the body still prints", () => {
  it("uses `formatWarning`'s production rule: identical cause dropped, new cause kept", () => {
    // The real closure body: identical cause is the A1 duplicate…
    expect(formatWarning("zh", `Provider check failed for "probe2": ${MISSING_KEY}`, new Error(MISSING_KEY))).toBe(
      `警告： Provider check failed for "probe2": ${MISSING_KEY}`,
    )
    // …but a cause the body does not already contain is preserved — this is the
    // assertion that fails if the parenthesis was simply deleted.
    expect(formatWarning("zh", `Provider check failed for "probe2": ${MISSING_KEY}`, new Error("cause: DNS lookup failed"))).toBe(
      `警告： Provider check failed for "probe2": ${MISSING_KEY} (cause: DNS lookup failed)`,
    )
    // A superset cause counts as already said, so no duplicate either.
    expect(formatWarning("zh", `Provider check failed: ${MISSING_KEY}`, new Error(MISSING_KEY))).not.toContain("(")
    // No cause at all: unchanged from before this card.
    expect(formatWarning("zh", "solo")).toBe("警告： solo")
  })

  it("reaches the real onWarn closure through `openContext` + `hub.ai.test`", async () => {
    const baseUrl = await unauthorizedServer()
    const dir = await seedProviderWithoutCredential(baseUrl)
    const err: string[] = []
    const context = await openContext(
      parseCliArgs(["provider", "test", "probe2", "--db", join(dir, "usage.db"), "--config", join(dir, "mik.config.json")]),
      {
        cwd: dir,
        env: { ...process.env, MIK_LANG: "zh" },
        io: { out: () => {}, err: (text) => err.push(text) },
        hub: { syncCatalog: false, appId: "g70" },
      },
    )
    try {
      const status = await context.hub.ai.test("probe2")
      expect(status.ok).toBe(false)
    } finally {
      await context.close()
    }
    const joined = err.join("\n")
    expect(joined).toContain("Provider check failed")
    expect(joined).not.toContain(`(${MISSING_KEY})`)
    expect(occurrences(joined, MISSING_KEY)).toBe(1)
  })

  it("still redacts both the body and the cause", () => {
    const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    const rendered = formatWarning("zh", `Provider check failed: ${secret}`, new Error(`upstream said ${secret}`))
    expect(rendered).not.toContain(secret)
    // The parenthesis survives a cause that is not already in the body, redacted.
    expect(rendered).toContain("(")
    expect(rendered).not.toContain(secret)
  })
})

// ---------------------------------------------------------------------------
// G61 — the targeted warning filter
// ---------------------------------------------------------------------------

describe("EVO-G70 — G61: the SQLite experimental warning is filtered, others are not", () => {
  it("recognises only the node:sqlite notice", () => {
    const sqlite = "SQLite is an experimental feature and might change at any time"
    expect(isSuppressedWarning({ name: "ExperimentalWarning", message: sqlite })).toBe(true)
    expect(isSuppressedWarning({ name: "ExperimentalWarning", message: "Something else entirely" })).toBe(false)
    expect(isSuppressedWarning({ name: "DeprecationWarning", message: sqlite })).toBe(false)
    expect(isSuppressedWarning({ name: "Warning", message: "SQLite" })).toBe(false)
    expect(isSuppressedWarning(undefined)).toBe(false)
    expect(isSuppressedWarning("SQLite is an experimental feature")).toBe(false)
  })

  it("keeps a genuinely new warning visible while dropping only the sqlite one", async () => {
    // `process.emitWarning` cannot be used for this inside vitest: vitest
    // intercepts the call at the worker level, so no `warning` listener ever
    // runs (verified: a listener registered two lines above sees nothing while
    // the default reporter still prints). The same path is therefore exercised in
    // a plain child process whose only import is the public `main` entry — the
    // card's "targeted, not global" requirement as a decidable condition. The
    // *real* `node:sqlite` notice is covered by the end-to-end case below.
    const entry = new URL("../dist/cli.mjs", import.meta.url).href
    const sqlite = "SQLite is an experimental feature and might change at any time"
    const script = [
      `const { main } = await import(${JSON.stringify(entry)});`,
      'process.exitCode = await main(["--version"]);',
      `process.emitWarning(${JSON.stringify(sqlite)}, "ExperimentalWarning");`,
      'process.emitWarning("keep me visible", "DeprecationWarning");',
    ].join("\n")
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
    expect(child.status).toBe(0)
    expect(child.stderr).toContain("keep me visible")
    expect(child.stderr).not.toContain("SQLite is an experimental feature")
  })

  it("restores the parked listeners, so the filter is not a one-way global mute", () => {
    const before = process.listeners("warning")
    const restore = installWarningFilter()
    expect(process.listeners("warning")).not.toEqual(before)
    restore()
    expect(process.listeners("warning")).toEqual(before)
    // The reverse of the assertion above really can fail, so it is not vacuous.
    const again = installWarningFilter()
    expect(process.listeners("warning")).not.toEqual(before)
    again()
  })

  it("keeps the notice out of a real `mik` process's stderr (end-to-end)", () => {
    // The bin loads `node:sqlite` through the store on the first command that
    // opens the database; `--db` in a temp dir keeps the run off ~/.model-infra-kit.
    const entry = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url))
    const dir = tempDir()
    const child = spawnSync(
      process.execPath,
      [
        entry,
        "provider",
        "list",
        "--db",
        join(dir, "usage.db"),
        "--cache-dir",
        join(dir, "cache"),
        "--config",
        join(dir, "mik.config.json"),
      ],
      { encoding: "utf8", env: { ...process.env, MIK_LANG: "en", NO_COLOR: "1" } },
    )
    expect(child.status).toBe(0)
    expect(child.stderr).not.toContain("ExperimentalWarning")
    expect(child.stderr).not.toContain("SQLite is an experimental feature")
  })
})
