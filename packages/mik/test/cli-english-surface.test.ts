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
 * Both sides are normalised before comparison:
 *
 * - the banner embeds the package version, which legitimately changes every
 *   release (pinning 0.2.8 turned the 0.2.9 bump into a red CI);
 * - line endings differ by platform: the CLI emits `\n`, while Git for Windows
 *   checks these `.txt` files out as CRLF (`core.autocrlf=true`), which made
 *   every case fail on `windows-latest` only. `.gitattributes` pins them to LF,
 *   and this normalisation keeps the test correct even if that is bypassed.
 */
function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/model-infra-kit \(mik\) \d+\.\d+\.\d+/g, "model-infra-kit (mik) <version>")
}

describe("English CLI surface is frozen (version-controlled fixtures)", () => {
  for (const testCase of CASES) {
    it(`keeps the ${testCase.name} wording and exit code`, async () => {
      const expected = normalize(readFileSync(`${FIXTURES}/${testCase.file}`, "utf8")).trimEnd()
      const actual = await runCli(testCase.args)
      // Compare text exactly: a stray quote or a reworded hint must fail here.
      // Only the version number and the platform's line endings may differ.
      expect(normalize(actual.out).trimEnd()).toBe(expected)
      expect(actual.code).toBe(testCase.file === "help-en.txt" ? 0 : 2)
    })
  }
})
