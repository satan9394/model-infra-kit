import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { basename, join } from "node:path"
import { defaultHomeDir, expandPath } from "../util/paths.js"

/**
 * Quarantine (never delete) storage that must be recoverable by hand.
 *
 * This is the same trash root F04 introduced for credential files, so a user has
 * exactly one place to look: `~/.model-infra-kit/trash/`. `CredentialStore` moves
 * a single file in as `<name>.<stamp>`; a corrupt database needs a directory per
 * incident because the `-wal` / `-shm` siblings travel with it.
 */

/** `~/.model-infra-kit/trash` — the one trash root for the whole package. */
export function defaultTrashDir(): string {
  return join(defaultHomeDir(), "trash")
}

/** Filesystem-safe UTC stamp, matching the shape F04 uses for credential trash files. */
export function trashStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-")
}

export interface QuarantineResult {
  /** Absolute directory the damaged files were moved into. */
  dir: string
  /** Absolute paths of the files now living inside `dir`, in move order. */
  files: string[]
}

/**
 * Move one file into `targetDir`, keeping its basename.
 *
 * The source is only removed after the copy exists, so a failure can duplicate a
 * file but can never lose one. The `renameSync` fast path is the normal case; the
 * copy path exists because the default trash root lives on the home drive while a
 * host's ledger may live on another one (Windows `EXDEV`).
 */
export function quarantineFile(path: string, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, basename(path))
  try {
    renameSync(path, target)
    return target
  } catch {
    copyFileSync(path, target)
    unlinkSync(path)
    return target
  }
}

/** A directory name no earlier incident can have taken, e.g. `db-corrupt-2026-…`. */
function uniqueIncidentDir(root: string, now: Date): string {
  const base = `db-corrupt-${trashStamp(now)}`
  let candidate = join(root, base)
  for (let suffix = 2; existsSync(candidate); suffix += 1) candidate = join(root, `${base}-${suffix}`)
  return candidate
}

/**
 * Quarantine a SQLite database together with its `-wal` / `-shm` siblings.
 *
 * Every file is moved, none is deleted; if any move fails the error propagates so
 * the caller can keep throwing `STORAGE` with the original file still in place.
 */
export function quarantineDatabase(
  dbPath: string,
  options: { trashDir?: string; now?: Date } = {},
): QuarantineResult {
  const root = expandPath(options.trashDir ?? defaultTrashDir())
  mkdirSync(root, { recursive: true })
  const dir = uniqueIncidentDir(root, options.now ?? new Date())

  const files: string[] = []
  // The main file is moved first and decides the incident directory: the journal
  // siblings are meaningless without it.
  files.push(quarantineFile(dbPath, dir))
  for (const suffix of ["-wal", "-shm"]) {
    const sibling = `${dbPath}${suffix}`
    if (existsSync(sibling)) files.push(quarantineFile(sibling, dir))
  }
  return { dir, files }
}
