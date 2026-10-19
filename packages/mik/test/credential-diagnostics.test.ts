import { describe, expect, it, vi } from "vitest"
import { CredentialStore, CREDENTIAL_REFERENCE_ERROR, isCredentialReference } from "../src/credential/store.js"
import { probeProvider } from "../src/server/provider-probe.js"

describe("credential format diagnostics", () => {
  it("rejects bare values without disclosing even short secrets", () => {
    const store = new CredentialStore({ env: {} })
    for (const value of ["sk-test-only-not-a-secret", "abc", "unsupported:example"]) {
      expect(() => store.parse(value)).toThrow(CREDENTIAL_REFERENCE_ERROR)
      expect(CREDENTIAL_REFERENCE_ERROR).not.toContain(value)
    }
    for (const value of ["env:  ", "file:"]) {
      expect(() => store.parse(value)).toThrow(CREDENTIAL_REFERENCE_ERROR)
    }
    expect(CREDENTIAL_REFERENCE_ERROR).toContain("bare API key")
    expect(CREDENTIAL_REFERENCE_ERROR).toContain("env:VAR")
    expect(CREDENTIAL_REFERENCE_ERROR).toContain("file:PATH")
  })

  it("preserves references and the deliberate literal opt-in", () => {
    for (const value of ["env:TEST", "file:./test-key", " KEYCHAIN:service "]) expect(isCredentialReference(value)).toBe(true)
    expect(new CredentialStore({ allowLiteral: true }).resolve("test-only-value")).toBe("test-only-value")
    expect(new CredentialStore({ env: { TEST: "injected-test-value" } }).resolve("env:TEST")).toBe("injected-test-value")
  })

  it("probe rejects before resolving or networking and keeps the HTTP contract", async () => {
    const resolve = vi.fn()
    const fetch = vi.spyOn(globalThis, "fetch")
    try {
      await expect(probeProvider({ baseUrl: "https://api.openai.com/v1", protocol: "openai-compatible", apiKeyRef: "env:  " }, resolve))
        .rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST", message: CREDENTIAL_REFERENCE_ERROR })
      expect(resolve).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })
})
