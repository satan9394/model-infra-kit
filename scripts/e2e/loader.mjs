/**
 * Source-layout loader for the examples and the e2e runner.
 *
 * The examples are written the way a host would write them — they import the
 * published specifiers (`model-infra-kit`, `model-infra-kit/server`,
 * `model-infra-kit/cli`). Those resolve to `dist/` after a build. This loader
 * lets the very same files run against `packages/mik/src` instead, so the e2e
 * needs no build step and always exercises the current sources.
 *
 * Two rewrites, both narrow:
 *   1. the three package specifiers map onto the TypeScript entry points;
 *   2. a relative `./x.js` import that does not exist on disk falls back to
 *      `./x.ts` (TypeScript's own ESM style, which Node does not rewrite).
 *
 * Usage: `node --import ./scripts/e2e/loader.mjs <entry.ts>`
 */
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, resolve as resolvePath } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolvePath(here, "..", "..")
const mikSrc = resolvePath(repoRoot, "packages", "mik", "src")
/** Bare specifiers the examples and scripts use are the package's own deps. */
const mikPackageUrl = pathToFileURL(resolvePath(repoRoot, "packages", "mik", "index.mjs")).href

/** Published specifier → TypeScript source entry point. */
const SOURCE_ENTRIES = new Map([
  ["model-infra-kit", resolvePath(mikSrc, "index.ts")],
  ["model-infra-kit/server", resolvePath(mikSrc, "server", "index.ts")],
  ["model-infra-kit/cli", resolvePath(mikSrc, "cli", "index.ts")],
])

const TS_EXTENSIONS = [".ts", ".mts", ".tsx"]

registerHooks({
  resolve(specifier, context, nextResolve) {
    const entry = SOURCE_ENTRIES.get(specifier)
    if (entry) {
      if (!existsSync(entry)) {
        throw new Error(`scripts/e2e/loader.mjs: ${entry} does not exist.`)
      }
      return { url: pathToFileURL(entry).href, shortCircuit: true }
    }

    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
      const parent = context.parentURL ?? pathToFileURL(resolvePath(repoRoot, "index.mjs")).href
      let target
      try {
        target = fileURLToPath(new URL(specifier, parent))
      } catch {
        target = ""
      }
      if (target && target.endsWith(".js") && !existsSync(target)) {
        const stem = target.slice(0, -3)
        for (const extension of TS_EXTENSIONS) {
          if (existsSync(`${stem}${extension}`)) {
            return { url: pathToFileURL(`${stem}${extension}`).href, shortCircuit: true }
          }
        }
      }
    }

    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // A bare specifier that the caller cannot see (e.g. `ai` or `llm-pricing`
      // from the repo root) is retried from inside `packages/mik`, where the
      // package's own dependencies are linked.
      const bare = !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:")
      if (bare && !specifier.startsWith("node:") && context.parentURL !== mikPackageUrl) {
        return nextResolve(specifier, { ...context, parentURL: mikPackageUrl })
      }
      throw error
    }
  },
})
