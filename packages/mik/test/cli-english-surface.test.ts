import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { main } from "../src/cli/index.js"

/**
 * EVO-G12/G13 — the English CLI surface is frozen.
 *
 * The G12 review found that "en byte-parity" had been asserted only against
 * baselines living in `.tmp/` (git-ignored, so CI never saw them) and only for
 * one error shape. These fixtures are version-controlled on purpose: every
 * distinct error shape has a snapshot, so a change to any of them fails here
 * rather than shipping silently.
 *
 * Snapshots were taken from the published 0.2.8 artifact with `MIK_LANG=en`.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url))

/** One entry per CLI path whose English wording is contractual. */
const CASES: readonly { file: string; args: readonly string[]; name: string }[] = [
  { file: "help-en.txt", args: ["--help"], name: "root help" },
  { file: "unknown-command-en.txt", args: ["no-such-cmd"], name: "unknown command" },
  { file: "missing-argument-en.txt", args: ["provider", "remove"], name: "missing positional argument" },
  { file: "unknown-option-en.txt", args: ["--nope"], name: "unknown option" },
  { file: "flag-not-allowed-en.txt", args: ["usage", "summary", "--port", "1234"], name: "known option in the wrong place" },
]

async function runCli(args: readonly string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = []
  const code = await main(args, {
    io: { out: (text) => lines.push(text), err: (text) => lines.push(text) },
    // An English environment, so the frozen English wording is what gets compared.
    env: { ...process.env, MIK_LANG: "en" },
    interactive: false,
  })
  return { code, out: lines.join("\n") }
}

/**
 * The banner embeds the package version, which legitimately changes every
 * release. Both sides are normalised to `<version>` so the frozen fixtures keep
 * asserting the *wording* without turning every version bump into a red CI run
 * (G47 follow-up: the first version of this test pinned 0.2.8 and failed CI on
 * the 0.2.9 bump).
 */
function normalizeVersion(text: string): string {
  return text.replace(/model-infra-kit \(mik\) \d+\.\d+\.\d+/g, "model-infra-kit (mik) <version>")
}

describe("English CLI surface is frozen (version-controlled fixtures)", () => {
  for (const testCase of CASES) {
    it(`keeps the ${testCase.name} wording and exit code`, async () => {
      const expected = normalizeVersion(readFileSync(`${FIXTURES}/${testCase.file}`, "utf8")).trimEnd()
      const actual = await runCli(testCase.args)
      // Compare text exactly: a stray quote or a reworded hint must fail here.
      // Only the version number is allowed to differ between releases.
      expect(normalizeVersion(actual.out).trimEnd()).toBe(expected)
      expect(actual.code).toBe(testCase.file === "help-en.txt" ? 0 : 2)
    })
  }
})
