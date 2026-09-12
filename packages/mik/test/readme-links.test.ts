import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * EVO-G71 — the README npm users actually read must be clickable.
 *
 * R120: "what the user sees" has to be judged from the *published artifact*, not
 * from a file elsewhere in the repo. For this card the two happen to coincide —
 * `packages/mik/README.md` is the one npm packs as the package README — so this
 * test reads that file directly. The packaged copy is corroborated separately by
 * `npm pack` + `tar -x` in the card's evidence report; the assertion below pins
 * the path so it cannot silently drift to a different README.
 *
 * Before EVO-G71 this file's assertions were red: the README carried five
 * `../../` links, which from `node_modules/model-infra-kit/` resolve to
 * `node_modules/…` and 404.
 */

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url))
const README_PATH = join(PKG_DIR, "README.md")

/** Same shape as `grep -oE '\]\([^)]+\)'` — no Markdown parsing, on purpose. */
const LINK_RE = /\]\(([^)]+)\)/g

function markdownLinkTargets(md: string): string[] {
  const out: string[] = []
  for (const m of md.matchAll(LINK_RE)) {
    const target = m[1]
    if (target !== undefined) out.push(target.trim())
  }
  return out
}

/** Absolute by npm's rendering rules: a URL scheme, a fragment, or a mailto. */
function isAbsoluteTarget(target: string): boolean {
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("#") ||
    target.startsWith("mailto:")
  )
}

describe("EVO-G71 — packaged README link entry points", () => {
  const readme = readFileSync(README_PATH, "utf8")
  const targets = markdownLinkTargets(readme)

  it("reads the file npm ships (packages/mik/README.md)", () => {
    expect(README_PATH.replaceAll("\\", "/")).toMatch(/packages\/mik\/README\.md$/)
    expect(readme.startsWith("# model-infra-kit")).toBe(true)
  })

  it("extracts the README's links at all (so a green run is not vacuous)", () => {
    expect(readme.length).toBeGreaterThan(1000)
    expect(targets.length).toBeGreaterThanOrEqual(5)
  })

  it("has zero relative Markdown links", () => {
    const relative = targets.filter((t) => !isAbsoluteTarget(t))
    expect(relative, `relative links still shipped: ${relative.join(", ")}`).toEqual([])
  })

  it("no link climbs out of the package directory with ../../", () => {
    // From node_modules/model-infra-kit/ this resolves to node_modules/<x>, which
    // does not exist. Kept as its own assertion so the failure names the cause.
    const climbing = targets.filter((t) => t.startsWith("../../"))
    expect(climbing, `links escaping the package: ${climbing.join(", ")}`).toEqual([])
  })

  it("sends documentation links to the public GitHub repository", () => {
    const external = targets.filter((t) => t.startsWith("http"))
    expect(external.length).toBeGreaterThanOrEqual(5)
    for (const t of external) {
      expect(t, `non-GitHub absolute link: ${t}`).toMatch(/^https:\/\/github\.com\//)
    }
    // The repository this package is published from. Real, resolvable links are
    // the point of EVO-G71: a `<owner>/<repo>` placeholder would 404 and merely
    // trade five broken links for six. In *documentation prose* teaching readers
    // to fill in their own URLs, placeholders remain correct — not here, where
    // the link points at this repository itself.
    const BASE = "https://github.com/satan9394/model-infra-kit"
    for (const suffix of [
      // `examples/` is a directory, so GitHub needs `tree`, not `blob`.
      "/tree/main/examples/",
      "/blob/main/README.md",
      "/blob/main/docs/interfaces.md",
      "/blob/main/docs/decisions.md",
      "/blob/main/docs/cost-reconciliation.md",
    ]) {
      expect(targets, `missing entry point for ${suffix}`).toContain(`${BASE}${suffix}`)
    }
  })

  it("exposes the cost-reconciliation doc (closes the R110/R133 zero-entry gap)", () => {
    const hit = targets.filter(
      (t) => t.startsWith("https://") && t.includes("docs/cost-reconciliation.md"),
    )
    expect(hit.length).toBeGreaterThanOrEqual(1)
  })

  it("self-check: the guard rejects the exact shapes it is meant to reject", () => {
    expect(isAbsoluteTarget("../../docs/decisions.md")).toBe(false)
    expect(isAbsoluteTarget("../README.md")).toBe(false)
    expect(isAbsoluteTarget("./README.md")).toBe(false)
    expect(isAbsoluteTarget("docs/interfaces.md")).toBe(false)
    expect(isAbsoluteTarget("#anchor")).toBe(true)
    expect(isAbsoluteTarget("mailto:a@b.c")).toBe(true)
    expect(isAbsoluteTarget("https://github.com/<owner>/<repo>/blob/main/docs/x.md")).toBe(true)
    expect(markdownLinkTargets("see [a](../../a.md) and [b](https://x.y/z)")).toEqual([
      "../../a.md",
      "https://x.y/z",
    ])
  })
})
