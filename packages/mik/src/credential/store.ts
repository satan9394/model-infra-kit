import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { ModelInfraError } from "../errors.js"
import type { SqlDriver } from "../store/driver.js"
import { expandPath } from "../util/paths.js"
import { maskSecret } from "../util/redact.js"

export type CredentialBackend = "env" | "file" | "keychain" | "literal"

export interface ParsedCredentialRef {
  backend: CredentialBackend
  target: string
  /** The ref exactly as stored, for round-tripping. */
  raw: string
}

export interface CredentialStoreOptions {
  /** Where relative `file:` refs resolve from. Defaults to the process cwd. */
  fileRoot?: string
  /**
   * Accept a raw secret in `apiKeyRef`. Off by default: it makes accidental
   * plaintext storage a deliberate choice rather than a typo.
   */
  allowLiteral?: boolean
  /** When provided, refs are registered in the `credentials` table. */
  driver?: SqlDriver
}

const REF_PATTERN = /^(env|file|keychain):(.+)$/i

/**
 * Resolve a credential reference to its secret.
 *
 * Supported refs: `env:VAR`, `file:~/path/to/key`, `keychain:service`.
 * A bare string is treated as a literal only when `allowLiteral` is set.
 */
export class CredentialStore {
  constructor(private readonly options: CredentialStoreOptions = {}) {}

  parse(ref: string): ParsedCredentialRef {
    const trimmed = ref.trim()
    const match = REF_PATTERN.exec(trimmed)
    if (match) {
      const backend = match[1]!.toLowerCase() as CredentialBackend
      return { backend, target: match[2]!.trim(), raw: trimmed }
    }
    if (this.options.allowLiteral) return { backend: "literal", target: trimmed, raw: trimmed }
    throw new ModelInfraError(
      `Unsupported credential reference "${maskRef(trimmed)}". Use env:VAR, file:path or keychain:service.`,
      { code: "CREDENTIAL" },
    )
  }

  /** Resolve a ref to its secret value, or throw a CREDENTIAL error. */
  resolve(ref: string): string {
    const parsed = this.parse(ref)
    switch (parsed.backend) {
      case "env": {
        const value = process.env[parsed.target]
        if (!value) {
          throw new ModelInfraError(`Environment variable ${parsed.target} is not set for this provider's API key.`, {
            code: "CREDENTIAL",
          })
        }
        return value.trim()
      }
      case "file": {
        const path = this.resolveFilePath(parsed.target)
        if (!existsSync(path)) {
          throw new ModelInfraError(`Credential file not found: ${path}`, { code: "CREDENTIAL" })
        }
        const value = readFileSync(path, "utf8").trim()
        if (!value) throw new ModelInfraError(`Credential file is empty: ${path}`, { code: "CREDENTIAL" })
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

  /** Resolve without throwing; returns null when the secret is unavailable. */
  tryResolve(ref: string | undefined): string | null {
    if (!ref) return null
    try {
      return this.resolve(ref)
    } catch {
      return null
    }
  }

  /** Store a secret in the `file:` backend and register the ref. */
  set(ref: string, secret: string): void {
    const parsed = this.parse(ref)
    if (parsed.backend !== "file") {
      throw new ModelInfraError("Only file: references can be written by this store. Write env/keychain values yourself.", {
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
      if (existsSync(path)) rmSync(path)
    }
    this.options.driver?.prepare("DELETE FROM credentials WHERE ref = ?").run(parsed.raw)
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
