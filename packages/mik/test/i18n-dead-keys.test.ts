import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * EVO-G69 / G68 — the "translated but never wired" regression gate.
 *
 * A *dead* i18n key is one that both dictionaries define while no source file
 * references it. The user then keeps seeing the hardcoded English literal even
 * though a Chinese translation was written and reviewed. Nothing else catches
 * this class of gap: the zh/en key-parity test passes, the key-count check
 * passes, and a scan for hardcoded English literals passes too (the literal is
 * real English *and* the dictionary entry is real Chinese). It is the mirror
 * image of the same bug, which is why it needs its own guard.
 *
 * Baseline when this file was added: 6 dead keys (all in `commands/dashboard.ts`
 * plus `wizard.nextStepsTitle`). After the G69 wiring: 0.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url))

/** Dictionary files hold the key *definitions*, so they must not count as use sites. */
const DICT_FILES = new Set([join("cli", "i18n", "zh.ts"), join("cli", "i18n", "en.ts")])

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = prefix === "" ? entry : join(prefix, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, rel))
    else if (full.endsWith(".ts")) out.push(rel)
  }
  return out
}

const SOURCE_FILES = walk(SRC).filter((file) => !DICT_FILES.has(file))
const HAYSTACK = SOURCE_FILES.map((file) => readFileSync(join(SRC, file), "utf8")).join("\n")

/** Keys materialized by template interpolation, which never appear as literals. */
const DYNAMIC_PATTERNS: readonly RegExp[] = [
  /^cmd\..*\.summary$/, // help.ts `commandSummary` / `actionSummary`
  /^help\.details\./, // help.ts `detailBlock`
]

function deadKeys(keys: readonly string[], haystack: string, patterns: readonly RegExp[] = DYNAMIC_PATTERNS): string[] {
  return keys.filter((key) => !haystack.includes(`"${key}"`) && !patterns.some((pattern) => pattern.test(key)))
}

function isDynamic(key: string): boolean {
  return DYNAMIC_PATTERNS.some((pattern) => pattern.test(key))
}

/** The canonical key set, read from the same extraction rule as the source files. */
function dictionaryKeys(): string[] {
  const zh = readFileSync(join(SRC, "cli", "i18n", "zh.ts"), "utf8")
  return [...zh.matchAll(/^\s{2}"([^"]+)":/gm)].map((match) => match[1] ?? "")
}

const KEYS = dictionaryKeys()

describe("EVO-G69 — no i18n key is translated but unwired", () => {
  it("finds zero dead keys in src/ (the 6 G68 keys are wired)", () => {
    const dead = deadKeys(KEYS, HAYSTACK)
    expect(dead, `dead keys (defined but never referenced in src/):\n${dead.map((k) => `  ${k}`).join("\n")}`).toEqual([])
  })

  it("reads a real dictionary, so an empty scan cannot pass vacuously", () => {
    // Guards the extraction regex itself: a broken pattern would yield [] and
    // make the assertion above true for the wrong reason.
    expect(KEYS.length).toBeGreaterThan(280)
    expect(KEYS).toContain("dashboard.error.missingApp")
    expect(KEYS).toContain("cmd.dashboard.summary")
    // ...and the measured key set is not just the dynamic ones.
    expect(KEYS.filter((key) => !isDynamic(key)).length).toBeGreaterThan(200)
  })

  it("flags a deliberately dead key, so the predicate is not vacuous", () => {
    // Contrast: the very same predicate that returns [] above does report a key
    // with no use site, and still ignores a key that *is* wired.
    const probe = deadKeys(["dashboard.error.missingApp", "zzz.g69.deliberately.dead"], HAYSTACK)
    expect(probe).toEqual(["zzz.g69.deliberately.dead"])
  })

  it("excludes only the template-built families, and those are genuinely templates", () => {
    const dynamic = KEYS.filter(isDynamic)
    // Sanity: the two families are large, so the exclusion is load-bearing — if
    // it were omitted these keys alone would keep "dead keys = 0" unreachable.
    expect(dynamic.length).toBeGreaterThan(10)
    // And none of them appears as a literal, which is *why* they need excluding.
    expect(dynamic.filter((key) => HAYSTACK.includes(`"${key}"`))).toEqual([])
    // The exemption names mechanisms that exist in the source, rather than being
    // a free pass: both interpolation sites are asserted here.
    const help = readFileSync(join(SRC, "cli", "help.ts"), "utf8")
    expect(help).toContain("`cmd.${command.name}.summary`")
    expect(help).toContain("`cmd.${command.name}.${action.name}.summary`")
    expect(help).toContain("`help.details.${command.name}`")
    expect(help).toContain("`help.details.${command.name}.${action.name}`")
    // The scan covers the whole source tree, not one directory.
    expect(SOURCE_FILES.length).toBeGreaterThan(30)
    expect(SOURCE_FILES).toContain(join("cli", "commands", "dashboard.ts"))
  })

  it("keeps both dictionaries on the same key set (no one-sided deletion)", () => {
    const en = readFileSync(join(SRC, "cli", "i18n", "en.ts"), "utf8")
    const enKeys = [...en.matchAll(/^\s{2}"([^"]+)":/gm)].map((match) => match[1] ?? "")
    expect([...enKeys].sort()).toEqual([...KEYS].sort())
  })
})
