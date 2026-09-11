import { readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { MODEL_LIST_PROTOCOLS, PROTOCOLS, SDK_PROTOCOLS } from "../src/ai/protocols.js"

/**
 * EVO-G11 / G18 — directory-level module-graph guard.
 *
 * `repl.test.ts` used to assert only that `repl.ts` contains no
 * `from "./index.js"` **string**, which misses single quotes, `await import()`,
 * and any reverse edge from another file. This file builds the real import
 * graph for `src/**` and asserts it is acyclic.
 *
 * The G10a derived-view and G16 README checks live here too because they are
 * the same card's structural assertions (one file per card keeps the guard
 * surface discoverable).
 */

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url))
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url))

/** The three CLI modules whose edge direction is contractual. */
const CLI_INDEX = "cli/index.ts"
const CLI_REPL = "cli/repl.ts"
const CLI_DISPATCH = "cli/dispatch.ts"

/**
 * Every specifier an ES module can pull in and a cycle can hide behind:
 * static `import`/`export ... from`, bare side-effect `import`, and dynamic
 * `import()` — including the template-literal and bare-variable forms, which
 * are captured as *unresolved* specifiers so they cannot silently vanish.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // import ... from "x" | export ... from "x" (single/double quotes)
  /(?:^|[\s;{}])(?:import|export)\s[^;"'`]*?from\s*["']([^"']+)["']/gm,
  // import "x" (side-effect only)
  /(?:^|[\s;{}])import\s*["']([^"']+)["']/gm,
  // await import("x") / import('x') / import(`x`)
  /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  // import(identifier) — an unresolved edge; kept so callers must allowlist it
  /import\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)/g,
]

/** Variable (non-literal) `import(...)` expressions only, e.g. `import(npmPackage)`. */
const DYNAMIC_EXPRESSION_PATTERN = /import\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)/g

/** Strip comments so a commented-out import never enters the graph. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

/** All specifiers referenced by one file, unresolved ones included. */
export function specifiersOf(source: string): string[] {
  const code = stripComments(source)
  const found: string[] = []
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of code.matchAll(pattern)) found.push(match[1] ?? "")
  }
  return found
}

/** All `.ts` files under `src/`, POSIX-relative to `src/`. */
function sourceFiles(dir: string = SRC_DIR, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, acc)
    else if (entry.name.endsWith(".ts")) acc.push(relative(SRC_DIR, full).split(sep).join("/"))
  }
  return acc.sort()
}

/** Resolve a relative specifier (`./x.js`) to a POSIX-relative `.ts` module id. */
function resolveRelative(from: string, specifier: string): string {
  const base = from.split("/").slice(0, -1)
  const parts = [...base, ...specifier.replace(/^\.\//, "").split("/")]
  const stack: string[] = []
  for (const part of parts) {
    if (part === "." || part === "") continue
    if (part === "..") stack.pop()
    else stack.push(part)
  }
  const joined = stack.join("/")
  const candidates = [joined.replace(/\.js$/, ".ts"), `${joined.replace(/\.js$/, "")}/index.ts`]
  return candidates.find((candidate) => FILE_SET.has(candidate)) ?? joined
}

const FILES = sourceFiles()
const FILE_SET = new Set(FILES)

/** `from → to` edges of the whole `src/**` graph. */
function moduleGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const file of FILES) {
    const edges: string[] = []
    for (const specifier of specifiersOf(readFileSync(join(SRC_DIR, file), "utf8"))) {
      if (!specifier.startsWith(".")) continue // package specifier: not an intra-src edge
      const target = resolveRelative(file, specifier)
      if (FILE_SET.has(target)) edges.push(target)
    }
    graph.set(file, edges)
  }
  return graph
}

/** First cycle found by DFS, as a readable path, or `null` when acyclic. */
function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []

  const visit = (node: string): string[] | null => {
    const seen = state.get(node)
    if (seen === "visiting") return [...stack.slice(stack.indexOf(node)), node]
    if (seen === "done") return null
    state.set(node, "visiting")
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(node, "done")
    return null
  }

  for (const node of graph.keys()) {
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return null
}

describe("EVO-G11/G18 — src module graph", () => {
  it("scans every source file (the guard is not a handful of hand-picked files)", () => {
    expect(FILES.length).toBeGreaterThan(20)
    expect(FILES).toContain(CLI_DISPATCH)
    expect(FILES).toContain(CLI_INDEX)
    expect(FILES).toContain(CLI_REPL)
    // Nothing outside src/ leaks in, and ids are POSIX-relative.
    for (const file of FILES) {
      expect(file).not.toContain("\\")
      expect(file).not.toContain("..")
    }
  })

  it("sees static, quote-variant and dynamic import forms", () => {
    const source = [
      `import { a } from "./a.js"`,
      `import { b } from './b.js'`,
      `import "./side-effect.js"`,
      `export { c } from "./c.js"`,
      `const d = await import("./d.js")`,
      `const e = await import(\`./e.js\`)`,
      `const f = await import(spec.npmPackage)`,
      `// import { g } from "./commented-out.js"`,
    ].join("\n")
    const found = specifiersOf(source)
    for (const expected of ["./a.js", "./b.js", "./side-effect.js", "./c.js", "./d.js", "./e.js", "spec.npmPackage"]) {
      expect(found, expected).toContain(expected)
    }
    expect(found).not.toContain("./commented-out.js")
  })

  it("detects a cycle in a synthetic graph (so a green run is meaningful)", () => {
    const cyclic = new Map<string, string[]>([
      ["cli/dispatch.ts", ["cli/index.ts"]],
      ["cli/index.ts", ["cli/repl.ts"]],
      ["cli/repl.ts", ["cli/dispatch.ts"]],
    ])
    const cycle = findCycle(cyclic)
    expect(cycle).not.toBeNull()
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1])
  })

  it("has no import cycles anywhere under src/**", () => {
    expect(findCycle(moduleGraph())).toBeNull()
  })

  it("keeps the cli entry direction index → repl → dispatch with no back edges", () => {
    const graph = moduleGraph()
    const edges = (from: string) => graph.get(from) ?? []
    expect(edges(CLI_INDEX)).toContain(CLI_REPL)
    expect(edges(CLI_INDEX)).toContain(CLI_DISPATCH)
    expect(edges(CLI_REPL)).toContain(CLI_DISPATCH)
    // The reverse directions are exactly what G18 exists to forbid.
    expect(edges(CLI_DISPATCH)).not.toContain(CLI_INDEX)
    expect(edges(CLI_DISPATCH)).not.toContain(CLI_REPL)
    expect(edges(CLI_REPL)).not.toContain(CLI_INDEX)
  })

  it("only reaches outside the graph through two allowlisted dynamic sites", () => {
    // A variable specifier cannot be resolved statically, so every such site is
    // pinned here: a new `await import(someVar)` fails this test until someone
    // confirms it cannot form a cycle.
    //   ai/protocols.ts → spec.npmPackage  (optional `@ai-sdk/*` peer, installed by the user)
    //   cli/commands/serve.ts → url.href   (absolute file URL, never an intra-src path)
    const unresolved: string[] = []
    for (const file of FILES) {
      const code = stripComments(readFileSync(join(SRC_DIR, file), "utf8"))
      DYNAMIC_EXPRESSION_PATTERN.lastIndex = 0
      for (const match of code.matchAll(DYNAMIC_EXPRESSION_PATTERN)) unresolved.push(`${file} → ${match[1]}`)
    }
    expect(unresolved).toEqual([
      "ai/protocols.ts → spec.npmPackage",
      "cli/commands/serve.ts → url.href",
    ])
  })
})

describe("EVO-G11/G10a — single protocol source table", () => {
  it("derives both views from PROTOCOLS with identical key sets", () => {
    const keys = Object.keys(PROTOCOLS).sort()
    expect(keys.length).toBeGreaterThan(0)
    expect(Object.keys(SDK_PROTOCOLS).sort()).toEqual(keys)
    expect(Object.keys(MODEL_LIST_PROTOCOLS).sort()).toEqual(keys)
  })

  it("derives both views from PROTOCOLS with identical contents", () => {
    for (const protocol of Object.keys(PROTOCOLS) as Array<keyof typeof PROTOCOLS>) {
      expect(SDK_PROTOCOLS[protocol]).toBe(PROTOCOLS[protocol].sdk)
      expect(MODEL_LIST_PROTOCOLS[protocol]).toBe(PROTOCOLS[protocol].list)
    }
  })

  it("no longer declares the legacy tables as independent literals", () => {
    const source = readFileSync(join(SRC_DIR, "ai/protocols.ts"), "utf8")
    expect(source).toContain("export const PROTOCOLS: Record<Protocol, ProtocolSpec>")
    expect(source).not.toContain("MODEL_LIST_PROTOCOLS: Record<Protocol, ModelListProtocol> = {")
    expect(source).not.toContain("SDK_PROTOCOLS: Record<Protocol, SdkProtocol> = {")
  })
})

describe("EVO-G11/G16 — README carries no hardcoded version", () => {
  it("uses a placeholder in the help sample instead of a released version", () => {
    const readme = readFileSync(join(PKG_DIR, "..", "..", "README.md"), "utf8")
    expect(readme).toContain("model-infra-kit (mik) <version>")
    expect(readme).not.toMatch(/model-infra-kit \(mik\) \d+\.\d+\.\d+/)
  })
})
