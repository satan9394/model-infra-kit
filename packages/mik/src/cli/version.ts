import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const FALLBACK_VERSION = "0.1.0"

/**
 * Resolve the package version from `package.json`, checking both the source
 * layout (`src/cli/`) and the bundled one (`dist/`). The `name` check keeps a
 * neighbouring package's manifest from being read by mistake.
 */
export function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, "..", "..", "package.json"), join(here, "..", "package.json")]) {
    if (!existsSync(candidate)) continue
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string }
      if (pkg.name === "model-infra-kit" && typeof pkg.version === "string" && pkg.version) return pkg.version
    } catch {
      // Fall through to the next candidate, then to the constant.
    }
  }
  return FALLBACK_VERSION
}
