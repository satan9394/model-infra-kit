import assert from "node:assert/strict"
import test from "node:test"
import { buildCreateProviderPayload, buildProviderUpdatePayload, emptyProviderDraft, isValidApiKeyRef } from "./provider-presets.ts"
import { providerProbeError, providerStatusText } from "./provider-status.ts"
import { translator } from "./i18n/core.ts"

test("both payload builders reject bare keys but allow empty and supported references", () => {
  for (const apiKeyRef of ["bare-test-value", "env:", "env:  ", "file:", "unknown:test"]) {
    assert.equal(isValidApiKeyRef(apiKeyRef), false)
    for (const build of [buildCreateProviderPayload, buildProviderUpdatePayload]) {
      assert.deepEqual(build({ ...emptyProviderDraft(), id: "test", apiKeyRef }), { ok: false, error: "provider.probeCredential" })
    }
  }
  for (const apiKeyRef of ["", "env:TEST", "file:./key", " KEYCHAIN:service "]) {
    assert.equal(isValidApiKeyRef(apiKeyRef), true)
    assert.equal(buildCreateProviderPayload({ ...emptyProviderDraft(), id: "test", apiKeyRef }).ok, true)
  }
})

test("format and saved-provider errors retain actionable details in both languages", () => {
  for (const lang of ["en", "zh"] as const) {
    const t = translator(lang)
    const message = "Invalid credential reference: a bare API key was entered. Use env:VAR or file:PATH."
    const formatted = providerProbeError({ message: `HTTP 400: ${message}` }, t)
    assert.ok(formatted.startsWith(t("provider.probeCredential")))
    assert.ok(!formatted.startsWith(t("provider.offline")))
    assert.ok(formatted.includes("env:VAR"))
    assert.ok(formatted.includes("file:PATH"))
    assert.ok(providerStatusText({ providerId: "test", ok: false, checkedAt: 0, message }, t).includes(message))
    assert.ok(providerStatusText({ providerId: "test", ok: false, checkedAt: 0, message: "Environment variable TEST is not set." }, t).includes("TEST"))
  }
})
