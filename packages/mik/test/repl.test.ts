import { afterEach, describe, expect, it } from "vitest"
import { parseCliArgs } from "../src/cli/args.js"
import { openContext, type CliContext, type CliIo } from "../src/cli/context.js"
import { parseSlash, replHelp, resolveLangChoice, runRepl, handleLine, EXIT_USAGE } from "../src/cli/repl.js"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-repl-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err }
}

async function setup() {
  const dir = tempDir()
  const db = join(dir, "repl.db")
  const parsed = parseCliArgs(["--db", db, "--app-id", "repl-test", "--offline", "--cache-dir", join(dir, "cache")])
  const { io, out, err } = captureIo()
  const options = { io, env: { ...process.env, MIK_DB: db, MIK_OFFLINE: "1", MIK_APP_ID: "repl-test" }, interactive: false }
  const context = await openContext(parsed, options)
  return { parsed, options: { io, env: options.env, interactive: false } as typeof options, context, out, err, close: () => context.close() }
}

describe("parseSlash", () => {
  it("parses slash commands with arguments", () => {
    expect(parseSlash("/help")).toEqual({ name: "help", arg: "" })
    expect(parseSlash("/lang en")).toEqual({ name: "lang", arg: "en" })
    expect(parseSlash("/chat 你好 world")).toEqual({ name: "chat", arg: "你好 world" })
    expect(parseSlash("/models --refresh --provider deepseek")).toEqual({ name: "models", arg: "--refresh --provider deepseek" })
    expect(parseSlash("/exit")).toEqual({ name: "exit", arg: "" })
  })

  it("returns null for free text and empty lines", () => {
    expect(parseSlash("hello")).toBeNull()
    expect(parseSlash(" /hello? ")).toEqual({ name: "hello?", arg: "" })
    expect(parseSlash("")).toBeNull()
  })
})

describe("resolveLangChoice", () => {
  it("accepts numbers and language codes, rejects garbage", () => {
    expect(resolveLangChoice("1")).toBe("zh")
    expect(resolveLangChoice("2")).toBe("en")
    expect(resolveLangChoice("EN")).toBe("en")
    expect(resolveLangChoice("zh")).toBe("zh")
    expect(resolveLangChoice("日本語")).toBeNull()
  })
})

describe("replHelp", () => {
  it("lists every slash command with both languages", () => {
    const help = replHelp()
    expect(help).toContain("/providers")
    expect(help).toContain("列出供应商")
    expect(help).toContain("List providers")
    expect(help).toContain("/exit")
    expect(help).toContain("退出")
  })
})

describe("handleLine (headless)", () => {
  it("shows help on /help", async () => {
    const s = await setup()
    try {
      const result = await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, "zh", () => {}, "/help")
      expect(result.exit).toBe(false)
      expect(s.out.join("\n")).toContain("/lang")
    } finally {
      await s.close()
    }
  })

  it("switches and persists the language via /lang", async () => {
    const s = await setup()
    try {
      let current: "zh" | "en" = "zh"
      await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, current, (l) => (current = l), "/lang en")
      expect(current).toBe("en")
      expect(s.out.join("\n")).toContain("Language switched to English")
      expect(s.context.hub.readSetting("cli.lang")).toBe("en")
    } finally {
      await s.close()
    }
  })

  it("answers a bare /lang through the injected ask, without touching a TTY", async () => {
    const s = await setup()
    try {
      const asked: string[] = []
      // No TTY here: options.interactive is false and prompt() would block on
      // stdin — the ask path proves /lang never falls back to it.
      const ask = async (question: string) => {
        asked.push(question)
        return "2"
      }
      let current: "zh" | "en" = "zh"
      const result = await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, current, (l) => (current = l), "/lang", ask)
      expect(asked).toHaveLength(1)
      // G29: the sub-question follows the language in effect (zh here).
      expect(asked[0]).toContain("选择语言")
      expect(asked[0]).not.toContain("Select language")
      expect(result.exit).toBe(false)
      expect(current).toBe("en")
      expect(s.out.join("\n")).toContain("Language switched to English")
      expect(s.context.hub.readSetting("cli.lang")).toBe("en")
    } finally {
      await s.close()
    }
  })

  it("asks the bare-/lang prompt in the active language (G29)", async () => {
    const s = await setup()
    try {
      const asked: string[] = []
      const ask = async (question: string) => {
        asked.push(question)
        return "en"
      }
      // zh first: the question must be Chinese, not the old hardcoded English.
      const zh = await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, "zh", () => {}, "/lang", ask)
      expect(zh.lang).toBe("en")
      const en = await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, "en", () => {}, "/lang", ask)
      expect(en.lang).toBe("en")
      expect(asked[0]).toContain("选择语言")
      expect(asked[0]).not.toContain("Select language")
      expect(asked[1]).toContain("Select language")
      expect(asked[1]).not.toContain("选择语言")
    } finally {
      await s.close()
    }
  })

  it("reports a bare /chat with a localized usage hint (G29)", async () => {
    const s = await setup()
    try {
      await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, "zh", () => {}, "/chat")
      await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, "en", () => {}, "/chat")
      const err = s.err.join("\n")
      expect(err).toContain("用法：/chat <prompt>")
      expect(err).toContain("Usage: /chat <prompt>")
    } finally {
      await s.close()
    }
  })

  it("reports an unknown slash command", async () => {    const s = await setup()
    try {
      await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, "zh", () => {}, "/nope")
      expect(s.err.join("\n")).toContain("未知命令 /nope")
    } finally {
      await s.close()
    }
  })

  it("exits on /exit", async () => {
    const s = await setup()
    try {
      const result = await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, "zh", () => {}, "/exit")
      expect(result.exit).toBe(true)
    } finally {
      await s.close()
    }
  })

  it("routes /providers through the CLI on the same database", async () => {
    const s = await setup()
    try {
      await handleLine({ parsed: s.parsed, options: s.options, context: s.context }, "zh", () => {}, "/providers")
      const text = s.out.join("\n")
      // The provider list empty-state header appears (or a provider table).
      expect(text).toMatch(/No providers configured|PROVIDER/)
    } finally {
      await s.close()
    }
  })
})

describe("runRepl without a TTY", () => {
  it("refuses with a clear message when stdin is not a terminal", async () => {
    const { io, err } = captureIo()
    // The message language now follows MIK_LANG → cli.lang → OS locale → en, so
    // the locale is injected: LC_ALL wins over LANG/LC_MESSAGES and stops this
    // assertion from depending on the runner (CI is usually en_*).
    const code = await runRepl(parseCliArgs([]), { io, env: { ...process.env, LC_ALL: "zh_CN.UTF-8" }, interactive: false })
    expect(code).toBe(EXIT_USAGE)
    expect(err.join("\n")).toContain("需要一个终端")
  })

  it("prints the same refusal in English when the language resolves to en", async () => {
    const { io, err } = captureIo()
    const code = await runRepl(parseCliArgs([]), { io, env: { ...process.env, MIK_LANG: "en" }, interactive: false })
    expect(code).toBe(EXIT_USAGE)
    expect(err.join("\n")).toContain("needs a TTY")
  })
})

describe("EVO-G03 cycle guard", () => {
  it("repl.ts must not import from ./index.js", () => {
    const source = readFileSync(new URL("../src/cli/repl.ts", import.meta.url), "utf8")
    expect(source).not.toContain('from "./index.js"')
  })
})