import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import {
  buildCreateProviderPayload,
  buildProviderUpdatePayload,
  draftFromPreset,
  emptyProviderDraft,
  isValidApiKeyRef,
  isValidProviderId,
  parseProviderHeaders,
  PROVIDER_PRESETS,
  PROVIDER_PROTOCOLS,
} from "../lib/provider-presets.ts"

test("provider ID HTML pattern compiles under browser Unicode sets mode", () => {
  const source = readFileSync(new URL("../components/add-provider-modal.tsx", import.meta.url), "utf8")
  const pattern = source.match(/pattern="([^"]+)"/)?.[1]
  assert.ok(pattern)
  const browserPattern = new RegExp(`^(?:${pattern})$`, "v")
  assert.ok(browserPattern.test("my.gateway_2-prod"))
  assert.equal(browserPattern.test("bad:id"), false)
  assert.equal(browserPattern.test("<script>"), false)
})

test("provider protocol options match the dashboard API contract", () => {
  assert.deepEqual(PROVIDER_PROTOCOLS, [
    "openai-compatible",
    "anthropic",
    "openai",
    "google",
    "deepseek",
    "moonshotai",
    "xai",
  ])
})

test("built-in presets provide the expected endpoint, protocol, and key reference", () => {
  const expected = {
    deepseek: ["DeepSeek", "deepseek", "https://api.deepseek.com/v1", "env:DEEPSEEK_API_KEY"],
    openai: ["OpenAI", "openai", "https://api.openai.com/v1", "env:OPENAI_API_KEY"],
    anthropic: ["Anthropic", "anthropic", "https://api.anthropic.com/v1", "env:ANTHROPIC_API_KEY"],
    google: ["Google Gemini", "google", "https://generativelanguage.googleapis.com/v1beta", "env:GOOGLE_GENERATIVE_AI_API_KEY"],
    openrouter: ["OpenRouter", "openai-compatible", "https://openrouter.ai/api/v1", "env:OPENROUTER_API_KEY"],
    ollama: ["Ollama (Local)", "openai-compatible", "http://localhost:11434/v1", ""],
  } as const

  assert.ok(PROVIDER_PRESETS.length >= 25)
  assert.equal(new Set(PROVIDER_PRESETS.map(preset => preset.id)).size, PROVIDER_PRESETS.length)
  for (const [id, [name, protocol, baseUrl, apiKeyRef]] of Object.entries(expected)) {
    const draft = draftFromPreset(id as keyof typeof expected)
    assert.equal(draft.id, id)
    assert.equal(draft.name, name)
    assert.equal(draft.protocol, protocol)
    assert.equal(draft.baseUrl, baseUrl)
    assert.equal(draft.apiKeyRef, apiKeyRef)
    assert.equal(draft.enabled, true)
  }
  assert.equal(draftFromPreset("custom").id, "")
  assert.equal(draftFromPreset("custom").protocol, "openai-compatible")
})

test("provider IDs accept only the documented characters and length", () => {
  assert.equal(isValidProviderId("my.gateway_2-prod"), true)
  assert.equal(isValidProviderId("a".repeat(64)), true)
  assert.equal(isValidProviderId(""), false)
  assert.equal(isValidProviderId("a".repeat(65)), false)
  assert.equal(isValidProviderId("my:gateway"), false)
  assert.equal(isValidProviderId("my gateway"), false)
})

test("headers parser accepts string records and rejects malformed shapes", () => {
  assert.deepEqual(parseProviderHeaders('{"HTTP-Referer":"https://example.com"}'), {
    ok: true,
    value: { "HTTP-Referer": "https://example.com" },
  })
  assert.deepEqual(parseProviderHeaders(""), { ok: true, value: {} })
  assert.equal(parseProviderHeaders("{").ok, false)
  assert.equal(parseProviderHeaders("[]").ok, false)
  assert.equal(parseProviderHeaders("null").ok, false)
  assert.equal(parseProviderHeaders('{"x-retry-count":3}').ok, false)
})

test("create payload trims fields and omits empty optional endpoint and key values", () => {
  const draft = { ...draftFromPreset("ollama"), id: " local-ollama ", name: " Ollama Local " }
  const result = buildCreateProviderPayload(draft)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, {
    id: "local-ollama",
    name: "Ollama Local",
    protocol: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    headers: {},
    enabled: true,
  })
  assert.equal("apiKeyRef" in result.value, false)
})

test("update payload includes every editable field and does not send the immutable ID", () => {
  const draft = {
    ...emptyProviderDraft(),
    id: "gateway-1",
    name: " Edge Gateway ",
    protocol: "xai",
    baseUrl: "",
    apiKeyRef: "",
    headersJson: '{"X-Region":"west"}',
    enabled: false,
    presetId: "custom-openai-compatible",
  }
  const result = buildProviderUpdatePayload(draft)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, {
    name: "Edge Gateway",
    protocol: "xai",
    baseUrl: "",
    apiKeyRef: "",
    headers: { "X-Region": "west" },
    enabled: false,
    presetId: "custom-openai-compatible",
  })
  assert.equal("id" in result.value, false)
})

test("payload builders reject invalid IDs, protocols, and header JSON", () => {
  assert.equal(buildCreateProviderPayload({ ...emptyProviderDraft(), id: "bad:id" }).ok, false)
  assert.equal(buildProviderUpdatePayload({ ...emptyProviderDraft(), id: "openai", protocol: "not-a-protocol" }).ok, false)
  assert.equal(buildProviderUpdatePayload({ ...emptyProviderDraft(), id: "openai", headersJson: "{nope" }).ok, false)
})


test("model metadata round-trips without losing unrelated provider metadata", () => {
  const meta = { models: ["a", "custom"], defaultModelId: "a", routing: "preserve" }
  for (const build of [buildCreateProviderPayload, buildProviderUpdatePayload]) {
    const payload = build({ ...draftFromPreset("deepseek"), meta })
    assert.ok(payload.ok)
    assert.deepEqual(payload.value.meta, meta)
    const empty = build({ ...draftFromPreset("deepseek"), meta: { models: [] } })
    assert.ok(empty.ok)
    assert.deepEqual(empty.value.meta, { models: [] })
  }
})

test("isValidApiKeyRef accepts empty keys, raw keys, and valid refs while rejecting empty prefix targets", () => {
  assert.equal(isValidApiKeyRef(""), true)
  assert.equal(isValidApiKeyRef("   "), true)
  assert.equal(isValidApiKeyRef("sk-proj-1234567890"), true)
  assert.equal(isValidApiKeyRef("vault:my-provider"), true)
  assert.equal(isValidApiKeyRef("env:OPENAI_API_KEY"), true)
  assert.equal(isValidApiKeyRef("file:/path/to/key.txt"), true)
  assert.equal(isValidApiKeyRef("keychain:my-account"), true)
  assert.equal(isValidApiKeyRef("env:"), false)
  assert.equal(isValidApiKeyRef("file:  "), false)
  assert.equal(isValidApiKeyRef("vault:"), false)
})

