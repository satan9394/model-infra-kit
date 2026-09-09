import { homedir } from "node:os"
import { join, isAbsolute } from "node:path"

/** Expand a leading `~` and return an absolute path. */
export function expandPath(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : join(process.cwd(), path)
}

/** `~/.model-infra-kit` */
export function defaultHomeDir(): string {
  return join(homedir(), ".model-infra-kit")
}

/** Default SQLite location. */
export function defaultDbPath(): string {
  return join(defaultHomeDir(), "usage.db")
}

/** Default catalogue cache directory. */
export function defaultCacheDir(): string {
  return join(defaultHomeDir(), "cache")
}
