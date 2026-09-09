import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PricingCache } from "llm-pricing"

/** A catalogue URL is not a filename; hash it so any source can be cached. */
function cacheFile(dir: string, key: string): string {
  return join(dir, `${createHash("sha256").update(key).digest("hex")}.json`)
}

/**
 * A `PricingCache` backed by files on disk.
 *
 * Survives restarts, so a process does not re-download models.dev's ~4 MB
 * `api.json` on every boot. Writes go to a temporary name and are renamed into
 * place: a process killed mid-write leaves the previous entry intact rather
 * than a truncated one.
 *
 * Every failure is swallowed. A cache is an optimisation, and a read-only or
 * full cache directory must not stop prices from loading.
 */
export function createFileCache(dir: string): PricingCache {
  return {
    get(key) {
      try {
        return readFileSync(cacheFile(dir, key), "utf8")
      } catch {
        return null
      }
    },
    set(key, value) {
      const target = cacheFile(dir, key)
      const temp = `${target}.${process.pid}.tmp`
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(temp, value, "utf8")
        renameSync(temp, target)
      } catch {
        // Left to the next write; a stale `.tmp` is inert.
      }
    },
  }
}
