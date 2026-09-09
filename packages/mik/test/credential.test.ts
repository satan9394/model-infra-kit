import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CredentialStore, defaultSecretPath } from "../src/credential/store.js"
import { ModelInfraError } from "../src/errors.js"
import { Store } from "../src/store/database.js"

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-cred-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe("CredentialStore", () => {
  it("resolves env: references", () => {
    process.env.MIK_TEST_KEY = "sk-test-1234567890"
    const store = new CredentialStore()
    expect(store.resolve("env:MIK_TEST_KEY")).toBe("sk-test-1234567890")
    delete process.env.MIK_TEST_KEY
  })

  it("reports a missing environment variable as a credential error", () => {
    const store = new CredentialStore()
    expect(() => store.resolve("env:MIK_DEFINITELY_MISSING")).toThrowError(ModelInfraError)
    try {
      store.resolve("env:MIK_DEFINITELY_MISSING")
    } catch (error) {
      expect((error as ModelInfraError).code).toBe("CREDENTIAL")
    }
  })

  it("writes and reads file: references with 0600 permissions", () => {
    const dir = tempDir()
    const path = join(dir, "key")
    const store = new CredentialStore()
    store.set(`file:${path}`, "sk-file-abcdef\n")
    expect(store.resolve(`file:${path}`)).toBe("sk-file-abcdef")
    store.delete(`file:${path}`)
    expect(() => store.resolve(`file:${path}`)).toThrowError(ModelInfraError)
  })

  it("refuses a bare secret unless literals are explicitly allowed", () => {
    expect(() => new CredentialStore().parse("sk-plain-text")).toThrowError(ModelInfraError)
    expect(new CredentialStore({ allowLiteral: true }).resolve("sk-plain-text")).toBe("sk-plain-text")
  })

  it("fails loudly for the unimplemented keychain backend", () => {
    const store = new CredentialStore()
    expect(() => store.resolve("keychain:my-service")).toThrowError(/not implemented/)
  })

  it("never returns the secret from list() or describe()", async () => {
    const dir = tempDir()
    const path = join(dir, "key")
    writeFileSync(path, "sk-supersecret-tail")
    const store = await Store.open({ path: ":memory:" })
    try {
      const credentials = new CredentialStore({ driver: store.driver })
      credentials.set(`file:${path}`, "sk-supersecret-tail")
      const entries = credentials.list()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.masked).toBe("****tail")
      expect(JSON.stringify(entries)).not.toContain("supersecret")
      expect(credentials.describe(`file:${path}`)).toBe("****tail")
    } finally {
      store.close()
    }
  })

  it("builds a default secret path for a provider", () => {
    expect(defaultSecretPath("deepseek")).toContain("deepseek-api-key")
  })
})
