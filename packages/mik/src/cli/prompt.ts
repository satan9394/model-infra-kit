import { createInterface } from "node:readline/promises"
import type { RunOptions } from "./context.js"

/**
 * Interactive helpers. Everything in the CLI must also work with no terminal
 * attached (CI, tests, piped output), so callers check `isInteractive()` first.
 */
export function isInteractive(options: RunOptions = {}): boolean {
  if (options.interactive !== undefined) return options.interactive
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/** Ask a question on stdout and read one line from stdin. */
export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

export function isAffirmative(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer)
}
