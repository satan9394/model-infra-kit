#!/usr/bin/env node
/**
 * ARCH-012 — contract traceability verifier.
 *
 * Mechanically cross-checks three things that used to drift apart by hand:
 *
 *   1. the runtime export set each package entrypoint actually declares in
 *      `src/` versus the machine-readable list published in
 *      `docs/interfaces.md` (`mik-runtime-exports/v1`);
 *   2. the prose counts in the same contract section (`root NN, auto NN, …`)
 *      versus the real list lengths;
 *   3. every code reference (`path` + `line`) embedded in the `docs/diagrams/`
 *      JSON sources: the file must exist, be repository-relative and the line
 *      must fall inside it.
 *
 * Design rules this file obeys (see AGENTS.md 复盘):
 *   - **Exact set membership, never substring.** `PROTOCOLS` must NOT be
 *     satisfied by `SDK_PROTOCOLS`; the `--self-test` branch proves it.
 *   - **A mismatch exits non-zero.** Exit code 0 is the gate.
 *   - **The self-test's expectations are literal constants**, not derived from
 *     the checker itself, so it cannot pass by matching nothing.
 *
 * Usage:
 *   node scripts/verify-contracts.mjs              # verify (exit 1 on drift)
 *   node scripts/verify-contracts.mjs --json       # machine-readable result
 *   node scripts/verify-contracts.mjs --self-test  # prove the gate can block
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

/** Package entrypoints, in the order the contract lists them. */
export const ENTRYPOINTS = {
  ".": "packages/mik/src/index.ts",
  "./auto": "packages/mik/src/auto.ts",
  "./cli": "packages/mik/src/cli/index.ts",
  "./server": "packages/mik/src/server/index.ts",
}

/** Contract section whose runtime list is the machine-readable authority. */
export const CONTRACT_MARKER = "<!-- release-battery-runtime-exports:v1 -->"

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Strip line and block comments so `export` inside prose never counts. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/**
 * The runtime (non-type-only) export names a source file declares.
 * Pure: same text in, same sorted names out, no filesystem access.
 */
export function extractRuntimeExports(sourceText) {
  const text = stripComments(sourceText)
  const names = new Set()

  // `export { a, b as c, type T } [from "..."]` — a leading `type` keyword on
  // the whole statement, or on one member, means "not a runtime export".
  const block = /export\s+(type\s+)?\{([\s\S]*?)\}\s*(?:from\s*["'][^"']+["'])?/g
  let match
  while ((match = block.exec(text))) {
    if (match[1]) continue
    for (const member of match[2].split(",")) {
      const trimmed = member.trim()
      if (!trimmed) continue
      if (/^type\s/.test(trimmed)) continue
      const alias = /\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(trimmed)
      const name = alias ? alias[1] : trimmed
      if (IDENTIFIER.test(name)) names.add(name)
    }
  }

  // Direct declarations that are runtime exports by construction.
  const declared = /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
  while ((match = declared.exec(text))) names.add(match[1])

  return [...names].sort()
}

/** Parse the `mik-runtime-exports/v1` JSON block from the contract text. */
export function extractDocumentedExports(interfacesText) {
  const index = interfacesText.indexOf(CONTRACT_MARKER)
  if (index < 0) throw new Error(`contract marker ${CONTRACT_MARKER} not found in docs/interfaces.md`)
  const json = interfacesText.slice(index)
  const start = json.indexOf("{")
  let depth = 0
  let end = -1
  for (let i = start; i < json.length; i++) {
    if (json[i] === "{") depth += 1
    else if (json[i] === "}") {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (start < 0 || end < 0) throw new Error("could not find the runtime-exports JSON object")
  const parsed = JSON.parse(json.slice(start, end))
  if (parsed.format !== "mik-runtime-exports/v1") throw new Error(`unexpected contract format: ${parsed.format}`)
  return parsed.entrypoints
}

/** Parse the prose counts `root **NN**, auto **NN**, CLI **NN**, server **NN**`. */
export function extractProseCounts(interfacesText) {
  const m = /root\s+\*\*(\d+)\*\*,\s*auto\s+\*\*(\d+)\*\*,\s*CLI\s+\*\*(\d+)\*\*,\s*server\s+\*\*(\d+)\*\*/.exec(interfacesText)
  if (!m) return null
  return { ".": Number(m[1]), "./auto": Number(m[2]), "./cli": Number(m[3]), "./server": Number(m[4]) }
}

/**
 * Compare one entrypoint's declared runtime exports with its documented list.
 * Exact membership both ways. Returns the two drift directions.
 */
export function compareExports(actual, documented) {
  const actualSet = new Set(actual)
  const documentedSet = new Set(documented)
  return {
    documentedButMissingFromSource: documented.filter((name) => !actualSet.has(name)),
    exportedButMissingFromDocumentation: actual.filter((name) => !documentedSet.has(name)),
  }
}

/** Walk a parsed diagram document and collect every `sources[]` code reference. */
export function collectDiagramReferences(document) {
  const refs = []
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node.sources)) {
      for (const source of node.sources) {
        if (source && typeof source.path === "string") {
          refs.push({ path: source.path, line: typeof source.line === "number" ? source.line : null, label: source.label ?? null })
        }
      }
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(document)
  return refs
}

/**
 * Validate one code reference against the filesystem. A reference is invalid
 * when it escapes the repository, points at a missing file, or names a line
 * outside the file.
 */
export function checkReference(ref, root = ROOT) {
  const issues = []
  if (isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes("..")) {
    return [`diagram reference escapes the repository: ${ref.path}`]
  }
  const absolute = join(root, ref.path)
  if (!existsSync(absolute)) {
    return [`diagram reference points at a missing file: ${ref.path}`]
  }
  if (ref.line !== null) {
    if (!Number.isInteger(ref.line) || ref.line < 1) issues.push(`diagram reference has an invalid line: ${ref.path}:${ref.line}`)
    else {
      const lines = readFileSync(absolute, "utf8").split("\n").length
      if (ref.line > lines) issues.push(`diagram reference line ${ref.line} is past the end of ${ref.path} (${lines} lines)`)
    }
  }
  return issues
}

/**
 * The whole check, over injected inputs so the self-test can drive it without
 * touching the repository.
 */
export function runChecks({ sources, interfacesText, diagrams = [], currentRevision = null }) {
  const issues = []
  const warnings = []
  const documented = extractDocumentedExports(interfacesText)
  const summary = {}

  for (const [entry, relativePath] of Object.entries(ENTRYPOINTS)) {
    const sourceText = sources[relativePath]
    if (sourceText === undefined) {
      issues.push(`entrypoint source is missing: ${relativePath}`)
      continue
    }
    const actual = extractRuntimeExports(sourceText)
    const listed = documented[entry]
    if (!Array.isArray(listed)) {
      issues.push(`contract has no runtime list for entrypoint "${entry}"`)
      continue
    }
    const drift = compareExports(actual, listed)
    for (const name of drift.documentedButMissingFromSource) {
      issues.push(`"${name}" is documented for "${entry}" but not exported by ${relativePath}`)
    }
    for (const name of drift.exportedButMissingFromDocumentation) {
      issues.push(`"${name}" is exported by ${relativePath} but missing from the "${entry}" contract`)
    }
    summary[entry] = { source: actual.length, documented: listed.length }
  }

  const prose = extractProseCounts(interfacesText)
  if (!prose) warnings.push("could not read the prose export counts from the contract")
  else {
    for (const [entry, count] of Object.entries(prose)) {
      const real = summary[entry]?.source
      if (real !== undefined && real !== count) issues.push(`the contract says "${entry}" has ${count} runtime exports but ${ENTRYPOINTS[entry]} declares ${real}`)
    }
  }

  let references = 0
  for (const diagram of diagrams) {
    const refs = collectDiagramReferences(diagram.document)
    references += refs.length
    for (const ref of refs) {
      for (const problem of checkReference(ref, diagram.root ?? ROOT)) issues.push(`${diagram.name}: ${problem}`)
    }
    const revision = diagram.document?.meta?.repository?.revision
    if (typeof revision === "string" && typeof currentRevision === "string" && revision !== currentRevision) {
      warnings.push(
        `${diagram.name} was generated at ${revision.slice(0, 8)} but HEAD is ${currentRevision.slice(0, 8)}; its line numbers may be stale (regenerate, do not hand-edit)`,
      )
    }
  }

  return { ok: issues.length === 0, issues, warnings, summary, references }
}

// ───────────────────────────── self-test (anti-tautology) ─────────────────────
/**
 * The gate is only worth having if it can actually fail. This branch feeds the
 * checker a *known-bad* contract and asserts it reports exactly the injected
 * drift. All expected values are literals here — never read back from
 * `runChecks` — so the test cannot pass by detecting nothing.
 */
function selfTest() {
  const realSources = readSources()
  // Normalise CRLF so the injected edits match regardless of checkout settings.
  const realInterfaces = readFileSync(join(ROOT, "docs/interfaces.md"), "utf8").replace(/\r\n/g, "\n")
  const realDiagrams = readDiagrams().filter((diagram) => diagram.document !== null)
  const baseline = runChecks({ sources: realSources, interfacesText: realInterfaces, diagrams: realDiagrams })
  const assertions = []
  const check = (label, condition) => assertions.push({ label, ok: Boolean(condition) })

  check("baseline repository verifies clean", baseline.ok === true)
  check("baseline examined a non-zero number of diagram references", baseline.references > 0)

  // Inject drift: drop a documented symbol, smuggle in a substring decoy, and
  // point one diagram reference at a path that does not exist.
  const brokenContracts = realInterfaces
    .replace('      "ModelInfra",\n', "")
    .replace('      "MODEL_LIST_PROTOCOLS",\n', '      "MODEL_LIST_PROTOCOLS",\n      "PROTOCOLS",\n')
  const broken = runChecks({
    sources: realSources,
    interfacesText: brokenContracts,
    diagrams: [
      {
        name: "synthetic.json",
        root: ROOT,
        document: { meta: {}, participants: [{ sources: [{ path: "packages/mik/src/does-not-exist.ts", line: 1 }] }] },
      },
    ],
  })

  check("a source export dropped from the contract is reported", broken.issues.some((issue) => issue.includes('"ModelInfra" is exported')))
  check(
    "a substring decoy is still reported missing (no substring false positive)",
    broken.issues.some((issue) => issue.includes('"PROTOCOLS" is documented')),
  )
  check("a missing diagram file is reported", broken.issues.some((issue) => issue.includes("does-not-exist.ts")))
  check("drift makes the gate fail", broken.ok === false)

  const failed = assertions.filter((assertion) => !assertion.ok)
  for (const assertion of assertions) process.stdout.write(`${assertion.ok ? "PASS" : "FAIL"}  ${assertion.label}\n`)
  if (failed.length > 0) {
    process.stdout.write(`self-test FAILED: ${failed.length}/${assertions.length}\n`)
    return 1
  }
  process.stdout.write(`self-test OK: ${assertions.length}/${assertions.length} (gate can block and does not use substring matching)\n`)
  return 0
}

// ───────────────────────────────────────── io ─────────────────────────────────
function readSources() {
  const sources = {}
  for (const relativePath of Object.values(ENTRYPOINTS)) {
    const absolute = join(ROOT, relativePath)
    if (existsSync(absolute)) sources[relativePath] = readFileSync(absolute, "utf8")
  }
  return sources
}

function readDiagrams() {
  const dir = join(ROOT, "docs", "diagrams")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      try {
        return { name, root: ROOT, document: JSON.parse(readFileSync(join(dir, name), "utf8")) }
      } catch (error) {
        return { name, root: ROOT, document: null, parseError: String(error) }
      }
    })
}

function currentRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest()
  // Real-process proof that the gate exits non-zero: run the exact same check
  // over what the contract would look like if a documented symbol were dropped.
  const injectFailure = argv.includes("--inject-failure")

  const diagrams = readDiagrams()
  const unparsable = diagrams.filter((diagram) => diagram.document === null)
  let interfacesText = readFileSync(join(ROOT, "docs", "interfaces.md"), "utf8")
  if (injectFailure) interfacesText = interfacesText.replace(/\r\n/g, "\n").replace('      "ModelInfra",\n', "")
  const result = runChecks({
    sources: readSources(),
    interfacesText,
    diagrams: diagrams.filter((diagram) => diagram.document !== null),
    currentRevision: currentRevision(),
  })
  if (injectFailure && result.ok) result.issues.push("failure injection did not produce drift; the gate is not measuring the contract")
  if (injectFailure) result.ok = false
  for (const diagram of unparsable) result.issues.push(`${diagram.name}: not valid JSON (${diagram.parseError})`)
  if (unparsable.length > 0) result.ok = false

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`runtime exports: ${Object.entries(result.summary).map(([entry, counts]) => `${entry} ${counts.source}`).join(", ")}\n`)
    process.stdout.write(`diagram references checked: ${result.references}\n`)
    for (const warning of result.warnings) process.stdout.write(`warning: ${warning}\n`)
    for (const issue of result.issues) process.stdout.write(`ERROR: ${issue}\n`)
    process.stdout.write(result.ok ? "verify-contracts: OK\n" : `verify-contracts: FAILED (${result.issues.length} issue(s))\n`)
  }
  return result.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
