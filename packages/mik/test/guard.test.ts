import { readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { PROTOCOL_PACKAGES, PROVIDER_PRESETS } from "../src/registry/presets.js"

/**
 * S9: protocol dispatch is a first-class rule (`AGENTS.md` rule 3), so the guard
 * has to look at the whole package, not three hand-picked files, and it has to
 * recognise the ways a vendor id can sneak into control flow.
 */

/** Absolute `src/` so the guard cannot silently point at a stale directory. */
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url))

/**
 * Every name that must stay out of control flow: the shipped preset ids plus the
 * protocol names they map to. Derived from the tables, so a new preset or
 * protocol is guarded the moment it is added.
 */
const VENDOR_NAMES = [
  ...new Set([...PROVIDER_PRESETS.map((preset) => preset.id), ...Object.keys(PROTOCOL_PACKAGES)]),
]

const QUOTE = "[\"'`]"

/** Any expression that could hold a provider id, preset id or protocol. */
const OPERAND = "[A-Za-z_$][\\w$.]*"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Longest first, so `custom-openai-compatible` is matched before `openai`. */
const VENDOR = VENDOR_NAMES.map(escapeRegExp)
  .sort((a, b) => b.length - a.length)
  .join("|")

/** The three shapes S9 called out, plus the reversed operand order and `!=`. */
const VIOLATION_FORMS: ReadonlyArray<{ readonly form: string; readonly pattern: RegExp }> = [
  {
    form: "equality",
    pattern: new RegExp(
      `${OPERAND}\\s*[!=]==?\\s*${QUOTE}(?:${VENDOR})${QUOTE}|` +
        `${QUOTE}(?:${VENDOR})${QUOTE}\\s*[!=]==?\\s*${OPERAND}`,
    ),
  },
  { form: "switch case", pattern: new RegExp(`\\bcase\\s*${QUOTE}(?:${VENDOR})${QUOTE}\\s*:`) },
  {
    form: "membership",
    pattern: new RegExp(`\\.(?:includes|has)\\(\\s*${QUOTE}(?:${VENDOR})${QUOTE}\\s*\\)`),
  },
  {
    form: "membership list",
    pattern: new RegExp(
      // `[...].includes(x)` and `new Set([...]).has(x)`.
      `\\[[^\\]\\n]*${QUOTE}(?:${VENDOR})${QUOTE}[^\\]\\n]*\\]\\s*\\)*\\s*\\.\\s*(?:includes|has)\\s*\\(`,
    ),
  },
]

interface Violation {
  readonly file: string
  readonly line: number
  readonly form: string
  readonly text: string
}

/**
 * Blank out comments while keeping line numbers intact. `//` after a `:` is left
 * alone so `https://…` inside a string is not mistaken for a comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

/** Every violation in one source text. Exported to the tests as a probe target. */
function findViolations(file: string, source: string): Violation[] {
  const code = stripComments(source)
  const violations: Violation[] = []
  for (const { form, pattern } of VIOLATION_FORMS) {
    for (const match of code.matchAll(new RegExp(pattern.source, "g"))) {
      violations.push({
        file,
        line: code.slice(0, match.index).split("\n").length,
        form,
        text: match[0].replace(/\s+/g, " ").trim(),
      })
    }
  }
  return violations
}

/** Scan a synthetic snippet exactly the way a real file is scanned. */
function scanSnippet(source: string): Violation[] {
  return findViolations("<snippet>", source)
}

/** Every `.ts` file under `dir`, recursively, in stable order. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listSourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full)
  }
  return files.sort()
}

const SOURCE_FILES = listSourceFiles(SRC_DIR)

function relativeName(file: string): string {
  return relative(SRC_DIR, file).split(sep).join("/")
}

describe("protocol dispatch guard", () => {
  it("scans every TypeScript file under src/", () => {
    const names = SOURCE_FILES.map(relativeName)
    // The old guard in ai-bridge.test.ts looked at three files; this one must
    // cover the whole package.
    expect(SOURCE_FILES.length).toBeGreaterThanOrEqual(40)
    expect(new Set(names).size).toBe(names.length)
    for (const required of [
      "hub.ts",
      "fetch.ts",
      "index.ts",
      "types.ts",
      "ai/bridge.ts",
      "ai/protocols.ts",
      "registry/registry.ts",
      "registry/presets.ts",
      "server/api.ts",
      "server/openai.ts",
      "cli/commands/provider.ts",
    ]) {
      expect(names).toContain(required)
    }
    // Nothing may be skipped or read as an empty file.
    expect(SOURCE_FILES.filter((file) => readFileSync(file, "utf8").trim().length === 0)).toEqual([])
    console.log(`[guard] scanned ${SOURCE_FILES.length} .ts files under src/`)
  })

  it("never branches on a vendor id, in any file", () => {
    const violations = SOURCE_FILES.flatMap((file) =>
      findViolations(relativeName(file), readFileSync(file, "utf8")),
    )
    expect(violations).toEqual([])
  })

  it("catches all three forbidden shapes in a synthetic snippet", () => {
    const snippets = [
      `if (providerId === "deepseek") return 1`,
      `if (record.id === "openai") return 1`,
      `if (record.id !== "anthropic") return 1`,
      `if ("google" === preset.id) return 1`,
      `if (record.protocol === "google") return 1`,
      `switch (record.id) { case "deepseek": return 1; default: return 0 }`,
      `switch (record.id) { case "moonshotai": return 1; default: return 0 }`,
      `if (["deepseek", "xai"].includes(record.id)) return 1`,
      `if (record.id.includes("deepseek")) return 1`,
      `if (new Set(["openrouter"]).has(record.id)) return 1`,
    ]
    for (const snippet of snippets) {
      expect(scanSnippet(snippet), snippet).not.toEqual([])
    }
  })

  it("leaves data-driven dispatch and unrelated code alone", () => {
    const snippets = [
      `const npmPackage = PROTOCOL_PACKAGES[protocol]`,
      `const preset = config.presetId ? getPreset(config.presetId) : undefined`,
      `if (asked.includes(":")) return`,
      `if (AUTH_HEADERS.includes(lower)) return`,
      `if (typeof value === "string" && Object.hasOwn(PROTOCOL_PACKAGES, value)) return`,
      `if (parsed.providerId !== providerId) return`,
      `if (id === parsed.providerId) return`,
      `switch (part.type) { case "text": return; default: return }`,
      `const url = "https://api.deepseek.com/v1"`,
      `registry.setDefaultModel("deepseek:deepseek-chat")`,
    ]
    for (const snippet of snippets) {
      expect(scanSnippet(snippet), snippet).toEqual([])
    }
  })

  it("does not flag vendor names that only appear as preset table data", () => {
    const source = [
      `export const PRESETS = [`,
      `  { id: "deepseek", protocol: "deepseek", name: "DeepSeek" },`,
      `  { id: "openai", protocol: "openai", name: "OpenAI" },`,
      `]`,
    ].join("\n")
    expect(scanSnippet(source)).toEqual([])
  })
})
