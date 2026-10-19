import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { ModelInfraError } from "../errors.js"
import type { SqlDriver } from "../store/driver.js"
import { defaultHomeDir, expandPath } from "../util/paths.js"
import { maskSecret } from "../util/redact.js"

export type CredentialBackend = "env" | "file" | "keychain" | "vault" | "literal"

export interface ParsedCredentialRef {
  backend: CredentialBackend
  target: string
  /** The ref exactly as stored, for round-tripping. */
  raw: string
}

export interface CredentialStoreOptions {
  /** Where relative `file:` refs resolve from. Defaults to the process cwd. */
  fileRoot?: string
  /** Where auto-vaulted `vault:` keys are stored. Defaults to `~/.model-infra-kit/vault`. */
  vaultDir?: string
  /** Injected environment snapshot for server configuration generations. */
  env?: NodeJS.ProcessEnv
  /**
   * Accept a raw secret in `apiKeyRef`. Off by default: it makes accidental
   * plaintext storage a deliberate choice rather than a typo.
   */
  allowLiteral?: boolean
  /** When provided, refs are registered in the `credentials` table. */
  driver?: SqlDriver
  /**
   * `delete()` moves files here instead of unlinking them, so a mistyped ref
   * is recoverable. Defaults to `~/.model-infra-kit/trash`.
   */
  trashDir?: string
}

const REF_PATTERN = /^(env|file|keychain|vault):(.+)$/i

/** Safe to show verbatim: never include the rejected value, even partially. */
export const CREDENTIAL_REFERENCE_ERROR = "Invalid credential reference: a bare API key or unsupported reference was entered. Use env:VAR, file:PATH, or vault:ID instead of the key itself (keychain:service is reserved)."

export function isCredentialReference(ref: string): boolean {
  const match = REF_PATTERN.exec(ref.trim())
  return !!match?.[2]?.trim()
}

/**
 * Resolve a credential reference to its secret.
 *
 * Supported refs: `env:VAR`, `file:~/path/to/key`, `keychain:service`.
 * A bare string is treated as a literal only when `allowLiteral` is set.
 */
export class CredentialStore {
  private frozen: Map<string, string> | undefined
  constructor(private readonly options: CredentialStoreOptions = {}) {}

  /** Freeze environment references for an in-flight server generation. */
  snapshotEnvironment(): void { this.options.env = { ...(this.options.env ?? process.env) } }

  /** Resolve every reference before freezing; file rotation cannot change old requests. */
  snapshotReferences(refs: string[]): void {
    const values = new Map<string, string>()
    for (const ref of refs) values.set(ref, this.resolve(ref))
    this.frozen = values
  }

  parse(ref: string): ParsedCredentialRef {
    const trimmed = ref.trim()
    const match = REF_PATTERN.exec(trimmed)
    if (match && match[2]!.trim()) {
      const backend = match[1]!.toLowerCase() as CredentialBackend
      return { backend, target: match[2]!.trim(), raw: trimmed }
    }
    if (this.options.allowLiteral) return { backend: "literal", target: trimmed, raw: trimmed }
    throw new ModelInfraError(
      `Unsupported credential reference "${maskRef(trimmed)}". ${CREDENTIAL_REFERENCE_ERROR}`,
      { code: "CREDENTIAL" },
    )
  }

  /** Resolve a ref to its secret value, or throw a CREDENTIAL error. */
  resolve(ref: string): string {
    if (this.frozen?.has(ref)) return this.frozen.get(ref)!
    const parsed = this.parse(ref)
    switch (parsed.backend) {
      case "env": {
        const value = (this.options.env ?? process.env)[parsed.target]
        if (!value?.trim()) {
          throw new ModelInfraError(`Environment variable ${parsed.target} is not set for this provider's API key.`, {
            code: "CREDENTIAL",
          })
        }
        return value.trim()
      }
      case "file": {
        const path = this.resolveFilePath(parsed.target)
        /**
         * ARCH-011: a resolution failure must not disclose the filesystem
         * path. The resolved path can reveal a home directory, a user name or
         * any other part of a secret's location, while the *reference* is a
         * thing the host already wrote down. Identify the failing ref with the
         * same masking `parse()` uses (`maskRef`), never the expanded path, and
         * never the file contents.
         */
        if (!existsSync(path)) {
          throw new ModelInfraError(
            `Credential file not found for reference "${maskRef(parsed.raw)}". Create the file the reference points at.`,
            { code: "CREDENTIAL" },
          )
        }
        const value = readFileSync(path, "utf8").trim()
        if (!value) {
          throw new ModelInfraError(
            `Credential file is empty for reference "${maskRef(parsed.raw)}". The file must contain only the key.`,
            { code: "CREDENTIAL" },
          )
        }
        return value
      }
      case "vault": {
        const path = this.resolveVaultPath(parsed.target)
        if (!existsSync(path)) {
          throw new ModelInfraError(
            `Credential file not found for vault reference "${maskRef(parsed.raw)}". Create the file the reference points at.`,
            { code: "CREDENTIAL" },
          )
        }
        const value = readFileSync(path, "utf8").trim()
        if (!value) {
          throw new ModelInfraError(
            `Credential file is empty for vault reference "${maskRef(parsed.raw)}". The file must contain only the key.`,
            { code: "CREDENTIAL" },
          )
        }
        return value
      }
      case "keychain":
        throw new ModelInfraError(
          "The keychain credential backend is not implemented yet. Use env: or file: instead.",
          { code: "CREDENTIAL" },
        )
      case "literal":
        return parsed.target
    }
  }

  /** Return the directory where vault credentials reside. */
  getVaultDir(): string {
    return expandPath(this.options.vaultDir ?? join(defaultHomeDir(), "vault"))
  }

  /** Resolve the path on disk for a vault target identifier. */
  resolveVaultPath(target: string): string {
    const clean = target.trim().replace(/[^A-Za-z0-9._-]/g, "_")
    const filename = clean.endsWith(".key") ? clean : `${clean}.key`
    return join(this.getVaultDir(), filename)
  }

  /** Write a secret to the vault directory and register its reference. */
  saveVaultSecret(targetId: string, secret: string): string {
    const path = this.resolveVaultPath(targetId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, secret.trim(), { mode: 0o600 })
    this.register({ backend: "vault", target: targetId, raw: `vault:${targetId}` })
    return path
  }

  /** Automatically save a raw key to the vault or return existing reference. */
  autoVault(providerId: string, secretOrRef: string): string {
    if (!secretOrRef || !secretOrRef.trim()) return secretOrRef
    const trimmed = secretOrRef.trim()
    if (isCredentialReference(trimmed)) return trimmed
    this.saveVaultSecret(providerId, trimmed)
    return `vault:${providerId}`
  }

  /** Resolve without throwing; returns null when the secret is unavailable. */
  tryResolve(ref: string | undefined): string | null {
    if (!ref) return null
    try {
      return this.resolve(ref)
    } catch {
      return null
    }
  }

  /** Store a secret in the `file:` or `vault:` backend and register the ref. */
  set(ref: string, secret: string): void {
    const parsed = this.parse(ref)
    if (parsed.backend === "vault") {
      this.saveVaultSecret(parsed.target, secret)
      return
    }
    if (parsed.backend !== "file") {
      throw new ModelInfraError("Only file: and vault: references can be written by this store. Write env/keychain values yourself.", {
        code: "CREDENTIAL",
      })
    }
    const path = this.resolveFilePath(parsed.target)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, secret.trim(), { mode: 0o600 })
    this.register(parsed)
  }

  delete(ref: string): void {
    const parsed = this.parse(ref)
    if (parsed.backend === "file") {
      const path = this.resolveFilePath(parsed.target)
      if (existsSync(path)) this.moveToTrash(path)
    } else if (parsed.backend === "vault") {
      const path = this.resolveVaultPath(parsed.target)
      if (existsSync(path)) this.moveToTrash(path)
    }
    this.options.driver?.prepare("DELETE FROM credentials WHERE ref = ?").run(parsed.raw)
  }

  /**
   * Move a credential file into the trash directory rather than unlinking it.
   * The project rule is that deletions must be recoverable; a secret file is
   * exactly the kind of thing that gets deleted by a mistyped reference.
   */
  private moveToTrash(path: string): void {
    const trashDir = expandPath(this.options.trashDir ?? join(defaultHomeDir(), "trash"))
    mkdirSync(trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const target = join(trashDir, `${basename(path)}.${stamp}`)
    try {
      renameSync(path, target)
    } catch {
      // A cross-device rename can fail; copying then removing keeps the
      // recoverable-delete promise either way.
      writeFileSync(target, readFileSync(path), { mode: 0o600 })
      rmSync(path)
    }
  }

  /** A ref plus whether its secret currently resolves. Never the secret itself. */
  list(): Array<{ ref: string; backend: CredentialBackend; available: boolean; masked: string }> {
    const rows = this.options.driver?.prepare("SELECT ref, backend FROM credentials ORDER BY ref").all() ?? []
    return rows.map((row) => {
      const ref = String(row.ref)
      const secret = this.tryResolve(ref)
      return {
        ref,
        backend: String(row.backend) as CredentialBackend,
        available: secret !== null,
        masked: secret ? maskSecret(secret) : "",
      }
    })
  }

  describe(ref: string): string {
    const secret = this.tryResolve(ref)
    return secret ? maskSecret(secret) : "(unresolved)"
  }

  private register(parsed: ParsedCredentialRef): void {
    this.options.driver
      ?.prepare(
        "INSERT INTO credentials (ref, backend, created_at) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET backend = excluded.backend",
      )
      .run(parsed.raw, parsed.backend, Date.now())
  }

  private resolveFilePath(target: string): string {
    const expanded = expandPath(target)
    return this.options.fileRoot && !expanded.startsWith("/") && !/^[A-Za-z]:/.test(expanded)
      ? resolve(this.options.fileRoot, target)
      : expanded
  }
}

function maskRef(ref: string): string {
  return ref.length <= 8 ? "****" : `${ref.slice(0, 4)}****${ref.slice(-2)}`
}

/** Convenience helper used by the CLI when scaffolding a new project. */
export function defaultSecretPath(providerId: string, home = "~/.model-infra-kit/secrets"): string {
  return `file:${join(home, `${providerId}-api-key`)}`
}
