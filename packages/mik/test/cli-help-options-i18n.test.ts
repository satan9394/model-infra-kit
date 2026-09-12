import { describe, expect, it } from "vitest"
import { COMMANDS, GLOBAL_FLAGS, type FlagSpec } from "../src/cli/args.js"
import { en } from "../src/cli/i18n/en.js"
import { zh } from "../src/cli/i18n/zh.js"
import { main } from "../src/cli/index.js"

/**
 * EVO-G58 — the `--help` option descriptions and `details` paragraphs are
 * localized, while the data on those lines (flag names, placeholders, default
 * paths, `env:`/`file:`/`keychain:` examples and the embedded command examples)
 * stay verbatim.
 *
 * Every assertion that claims a localization was run against the pre-change
 * source first: cases 1–4 and 6–7 were red, case 5 was red through the
 * `en[key] === literal` pins (the keys did not exist yet), and the coverage case
 * went red through the missing keys. Case 8 (exit codes) is an invariant and is
 * paired with an explicit contrast so it cannot pass vacuously.
 */

// ---------------------------------------------------------------------------
// Rendering harness — the language is always injected, never taken from the host
// ---------------------------------------------------------------------------

async function render(args: readonly string[], lang: "zh" | "en"): Promise<{ code: number; out: string }> {
  const lines: string[] = []
  const code = await main(args, {
    io: { out: (text) => lines.push(text), err: (text) => lines.push(text) },
    env: { ...process.env, MIK_LANG: lang },
    interactive: false,
  })
  return { code, out: lines.join("\n") }
}

async function help(args: readonly string[], lang: "zh" | "en"): Promise<string> {
  const { out } = await render(args, lang)
  return out
}

/** The sample set is closed on purpose: every command *and* every action. */
const HELP_CASES: readonly { name: string; args: readonly string[] }[] = [
  { name: "root", args: ["--help"] },
  { name: "init", args: ["init", "--help"] },
  { name: "provider", args: ["provider", "--help"] },
  { name: "provider-list", args: ["provider", "list", "--help"] },
  { name: "provider-add", args: ["provider", "add", "--help"] },
  { name: "provider-remove", args: ["provider", "remove", "--help"] },
  { name: "provider-test", args: ["provider", "test", "--help"] },
  { name: "models", args: ["models", "--help"] },
  { name: "pricing", args: ["pricing", "--help"] },
  { name: "pricing-list", args: ["pricing", "list", "--help"] },
  { name: "pricing-sync", args: ["pricing", "sync", "--help"] },
  { name: "pricing-set", args: ["pricing", "set", "--help"] },
  { name: "usage", args: ["usage", "--help"] },
  { name: "usage-summary", args: ["usage", "summary", "--help"] },
  { name: "usage-trends", args: ["usage", "trends", "--help"] },
  { name: "usage-logs", args: ["usage", "logs", "--help"] },
  { name: "usage-export", args: ["usage", "export", "--help"] },
  { name: "serve", args: ["serve", "--help"] },
  { name: "dashboard", args: ["dashboard", "--help"] },
]

/** The eight surfaces the card names (7 commands + `provider add`). */
const REQUIRED_CASES = ["init", "provider", "provider-add", "models", "pricing", "usage", "serve", "dashboard"]

// ---------------------------------------------------------------------------
// A1 scanner — "is this line still English prose?"
// ---------------------------------------------------------------------------

/**
 * Data surfaces inside a description, removed before counting. The column is a
 * *description*, so what remains after this strip must not read as prose.
 */
const DATA_STRIPPERS: readonly (readonly [RegExp, string])[] = [
  [/https?:\/\/\S+/g, " "],
  [/\b(?:env|file|keychain):[\w./-]+/g, " "],
  [/--[A-Za-z0-9][\w-]*/g, " "],
  [/(^|\s)-[A-Za-z](?=,|\s|$)/g, " "],
  [/<[^<>]*>/g, " "],
  [/[\w.~-]*\/[\w./~-]*/g, " "],
  // Dotted file/host names (`mik.config.json`, `app.example`) are paths, not words.
  [/[\w-]+(?:\.[\w-]+)+/g, " "],
  [/\b[A-Z][A-Z0-9_]{2,}\b/g, " "],
]

/**
 * A shell/usage example is data, not a description: `mik …` and the `curl …`
 * snippets in EXAMPLES literally invoke a program. Those lines are required to
 * stay English (card §2/§3), so they are outside the prose metric — and only
 * those lines. The banner is excluded because the package name is not prose.
 */
const EXAMPLE_LINE = /(^|[\s'"])mik\s|^\s*(?:curl|node|npm|pnpm|npx)\s/
const BANNER_LINE = /^model-infra-kit \(mik\) /

/**
 * Longest run of consecutive English-looking word tokens left in a line.
 *
 * The line is first cut at every character that cannot be part of an English
 * word *and* is not a word separator (Chinese characters, `（`, `、`, `|`, …):
 * a run can only grow inside one such chunk, through plain whitespace. Hyphens
 * are kept inside a token, so `openai-compatible` is one word, not two.
 */
function englishRun(line: string): number {
  let best = 0
  for (const chunk of line.split(/[^A-Za-z'\- \t]+/)) {
    let run = 0
    for (const token of chunk.split(/\s+/)) {
      if (token.length >= 2) {
        run += 1
        if (run > best) best = run
      } else {
        run = 0
      }
    }
  }
  return best
}

function proseOffenders(text: string): { line: string; run: number; stripped: string }[] {
  const offenders: { line: string; run: number; stripped: string }[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd()
    if (line.trim() === "" || BANNER_LINE.test(line.trim()) || EXAMPLE_LINE.test(line)) continue
    let stripped = line
    for (const [pattern, replacement] of DATA_STRIPPERS) stripped = stripped.replace(pattern, replacement)
    const run = englishRun(stripped)
    if (run >= 3) offenders.push({ line: line.trim(), run, stripped: stripped.trim() })
  }
  return offenders
}

// ---------------------------------------------------------------------------
// Key inventory — read through a cast so the pre-change proof is behavioural
// ---------------------------------------------------------------------------

function keyOf(spec: FlagSpec): string | undefined {
  return (spec as { descriptionKey?: string }).descriptionKey
}

function allFlags(): FlagSpec[] {
  const flags: FlagSpec[] = [...GLOBAL_FLAGS]
  for (const command of COMMANDS) {
    flags.push(...(command.flags ?? []))
    for (const action of command.actions ?? []) flags.push(...(action.flags ?? []))
  }
  return flags
}

function detailPairs(): { key: string; literal: string }[] {
  const pairs: { key: string; literal: string }[] = []
  for (const command of COMMANDS) {
    ;(command.details ?? []).forEach((literal, index) => {
      pairs.push({ key: `help.details.${command.name}.${index}`, literal })
    })
    for (const action of command.actions ?? []) {
      ;(action.details ?? []).forEach((literal, index) => {
        pairs.push({ key: `help.details.${command.name}.${action.name}.${index}`, literal })
      })
    }
  }
  return pairs
}

/**
 * The one line that must *not* be translated: the `mik provider add …` example
 * inside `init`'s details. Declared explicitly, and the guard below proves it
 * really is a command example (so the exemption cannot hide prose).
 */
const DATA_DETAIL_KEYS = new Set(["help.details.init.2"])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EVO-G58 — zh `--help` descriptions", () => {
  it("renders init's option descriptions and details in Chinese", async () => {
    const out = await help(["init", "--help"], "zh")
    expect(out).toContain("要注册的首个供应商预设（省略则不注册任何供应商）")
    expect(out).toContain("要写入的配置文件（默认 ./mik.config.json）")
    expect(out).toContain("不再询问确认")
    expect(out).toContain("首个供应商会写入数据库；配置文件只记录这项意图，")
    // The English literal must be gone, not merely accompanied by Chinese.
    expect(out).not.toContain("Config file to write")
    expect(out).not.toContain("Do not ask for confirmation")
  })

  it("renders provider add's descriptions and details in Chinese", async () => {
    const out = await help(["provider", "add", "--help"], "zh")
    expect(out).toContain("凭据引用：env:VAR、file:path 或 keychain:service（绝不接受明文密钥）")
    expect(out).toContain("供应商预设 id（如 openai、anthropic、deepseek、openrouter")
    expect(out).toContain("密钥仅作引用，绝不入库")
    expect(out).not.toContain("Credential reference")
    expect(out).not.toContain("Secrets are referenced")
  })

  it("renders serve's descriptions and details in Chinese", async () => {
    const out = await help(["serve", "--help"], "zh")
    expect(out).toContain("绑定主机（默认 127.0.0.1）")
    expect(out).toContain("端口已被占用时拒绝启动。")
    expect(out).toContain("GET 端点保持开放，所有写端点一律返回 401。")
    expect(out).not.toContain("Refuses to start")
    expect(out).not.toContain("Bind host (default")
  })

  it("keeps flag names, placeholders, default paths and examples verbatim (A4)", async () => {
    const init = await help(["init", "--help"], "zh")
    const add = await help(["provider", "add", "--help"], "zh")
    const serve = await help(["serve", "--help"], "zh")

    // Line-level, so the Chinese half being missing is what turns this red.
    expect(init).toMatch(/--db <path>\s+SQLite 数据库文件（默认 ~\/\.model-infra-kit\/usage\.db）/)
    expect(init).toMatch(/-y, --yes\s+不再询问确认/)
    expect(init).toContain("'mik provider add <id> --preset <presetId> --api-key-ref env:<ENV_VAR>'.")
    expect(add).toMatch(/--api-key-ref <ref>\s+凭据引用：env:VAR、file:path 或 keychain:service/)
    expect(add).toContain("openai-compatible | openai | anthropic | google | deepseek | moonshotai | xai")
    expect(serve).toMatch(/--port <n>\s+监听端口（默认 3211）/)
    expect(serve).toContain("优先使用 MIK_SERVER_TOKEN 环境变量而不是 --token")
    // ...and the same data survives untouched in English.
    const initEn = await help(["init", "--help"], "en")
    expect(initEn).toContain("--db <path>")
    expect(initEn).toContain("~/.model-infra-kit/usage.db")
    expect(initEn).toContain("-y, --yes")
  })

  it("has no English prose left in any command or action help (A1, closed sample set)", async () => {
    // The eight surfaces the card names are all present...
    for (const required of REQUIRED_CASES) {
      expect(HELP_CASES.map((item) => item.name), `missing ${required}`).toContain(required)
    }
    const report: Record<string, number> = {}
    const details: string[] = []
    for (const testCase of HELP_CASES) {
      const offenders = proseOffenders(await help(testCase.args, "zh"))
      report[testCase.name] = offenders.length
      for (const offender of offenders) details.push(`[${testCase.name}] run=${offender.run} :: ${offender.line}`)
    }
    expect(Object.values(report).reduce((sum, count) => sum + count, 0), details.join("\n")).toBe(0)
  })
})

describe("EVO-G58 — en stays byte-identical", () => {
  it("pins every dictionary value to its args.ts literal (no second English source drifts)", () => {
    const seen = new Set<string>()
    for (const spec of allFlags()) {
      const key = keyOf(spec)
      expect(key, `flag --${spec.name} has no descriptionKey`).toBeTruthy()
      if (!key) continue
      seen.add(key)
      expect(en[key], `en ${key}`).toBe(spec.description)
      expect(zh[key], `zh ${key}`).toBeTruthy()
      expect(zh[key], `zh ${key}`).not.toBe(spec.description)
    }
    for (const pair of detailPairs()) {
      seen.add(pair.key)
      if (DATA_DETAIL_KEYS.has(pair.key)) {
        // Declared data: no dictionary entry at all, and the guard proves it is
        // a command example rather than prose hiding behind an exemption.
        expect(EXAMPLE_LINE.test(pair.literal), pair.key).toBe(true)
        expect(en[pair.key], `en ${pair.key}`).toBeUndefined()
        expect(zh[pair.key], `zh ${pair.key}`).toBeUndefined()
        continue
      }
      expect(en[pair.key], `en ${pair.key}`).toBe(pair.literal)
      expect(zh[pair.key], `zh ${pair.key}`).toBeTruthy()
      expect(zh[pair.key], `zh ${pair.key}`).not.toBe(pair.literal)
    }
    // No orphan keys: every `help.flag.*` / `help.details.*` entry in the
    // dictionaries belongs to a real flag or details line (and the two
    // dictionaries agree on the set). `help.banner`/`help.heading.*`/`help.footer`
    // are the pre-existing G12 frame keys and are out of this namespace.
    const newNamespace = (key: string): boolean => key.startsWith("help.flag.") || key.startsWith("help.details.")
    const attached = [...seen].filter((key) => !DATA_DETAIL_KEYS.has(key)).sort()
    const enHelpKeys = Object.keys(en).filter(newNamespace).sort()
    const zhHelpKeys = Object.keys(zh).filter(newNamespace).sort()
    expect(attached).toEqual(enHelpKeys)
    expect(zhHelpKeys).toEqual(enHelpKeys)
  })

  it("keeps the English rendering unchanged", async () => {
    const init = await help(["init", "--help"], "en")
    expect(init).toContain("Config file to write (default ./mik.config.json)")
    expect(init).toContain("Do not ask for confirmation")
    expect(init).toContain("Prompts when stdin is a terminal")
    expect(init).not.toContain("要写入的配置文件")

    const add = await help(["provider", "add", "--help"], "en")
    expect(add).toContain("Credential reference: env:VAR, file:path or keychain:service (never a plaintext key)")
    expect(add).toContain("Secrets are referenced, never stored")
    expect(add).not.toContain("凭据引用")

    const usage = await help(["usage", "logs", "--help"], "en")
    expect(usage).toContain("Maximum rows to return (default 20, max 1000)")
    expect(usage).toContain("Filter by request status")
  })
})

describe("EVO-G58 — help framing is intact", () => {
  it("keeps exit code 0 for every help surface, with an explicit contrast", async () => {
    for (const testCase of HELP_CASES) {
      const { code } = await render(testCase.args, "zh")
      expect(code, testCase.name).toBe(0)
    }
    // Contrast: the same probe machinery does report failures, so the 0s above
    // are not vacuous.
    const failed = await render(["no-such-command"], "zh")
    expect(failed.code).toBe(2)
  })

  it("keeps the options column aligned in zh and en", async () => {
    const zhOut = await help(["init", "--help"], "zh")
    const enOut = await help(["init", "--help"], "en")
    // Same shape: the localization must not add, drop or reorder any line...
    expect(zhOut.split("\n").length).toBe(enOut.split("\n").length)
    // The usage line also mentions `--db <path>`; the option column is the line
    // that is not a shell example.
    const dbLine = (text: string): string =>
      text
        .split("\n")
        .filter((line) => line.includes("--db <path>") && !EXAMPLE_LINE.test(line))
        .pop() ?? ""
    // ...and the description still starts at the same offset, because the width
    // is computed from the ASCII flag names only.
    const zhIndex = dbLine(zhOut).indexOf("SQLite 数据库文件")
    const enIndex = dbLine(enOut).indexOf("SQLite database file")
    expect(zhIndex).toBeGreaterThan(0)
    expect(zhIndex).toBe(enIndex)
  })
})
