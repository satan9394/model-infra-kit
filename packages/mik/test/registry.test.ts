import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CredentialStore } from "../src/credential/store.js"
import { ModelInfraError } from "../src/errors.js"
import { PROVIDER_PRESETS, PROTOCOL_PACKAGES, getPreset } from "../src/registry/presets.js"
import { DEFAULT_MODEL_SETTING, ProviderRegistry, splitModelRef } from "../src/registry/registry.js"
import { Store } from "../src/store/database.js"
import type { Protocol, ProviderConfig } from "../src/types.js"

const REQUIRED_PRESET_IDS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "moonshotai",
  "xai",
  "openrouter",
  "custom-openai-compatible",
]

const ALL_PROTOCOLS: Protocol[] = ["openai", "anthropic", "google", "deepseek", "moonshotai", "xai", "openai-compatible"]

function codeOf(error: unknown): string | undefined {
  return error instanceof ModelInfraError ? error.code : undefined
}

/** Assert that `fn` throws a ModelInfraError carrying `code`. */
function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ModelInfraError)
    expect(codeOf(error)).toBe(code)
    return
  }
  throw new Error(`Expected a ModelInfraError with code ${code}, but nothing was thrown.`)
}

/** Run `fn` with `name` set to `value`, restoring the previous value afterwards. */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const original = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    fn()
  } finally {
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
}

describe("PROVIDER_PRESETS", () => {
  it("covers every provider required by the card", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    for (const id of REQUIRED_PRESET_IDS) expect(ids).toContain(id)
  })

  it("describes every preset completely and consistently", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0)
      expect(preset.name.length).toBeGreaterThan(0)
      expect(ALL_PROTOCOLS).toContain(preset.protocol)
      expect(preset.npmPackage).toBe(PROTOCOL_PACKAGES[preset.protocol])
      expect(preset.docUrl).toMatch(/^https:\/\//)
    }
  })

  it("maps every protocol to an @ai-sdk package", () => {
    expect(Object.keys(PROTOCOL_PACKAGES).sort()).toEqual([...ALL_PROTOCOLS].sort())
    for (const protocol of ALL_PROTOCOLS) {
      expect(PROTOCOL_PACKAGES[protocol]).toMatch(/^@ai-sdk\//)
    }
  })

  it("has at least one preset per protocol", () => {
    for (const protocol of ALL_PROTOCOLS) {
      expect(PROVIDER_PRESETS.some((preset) => preset.protocol === protocol)).toBe(true)
    }
  })

  it("resolves presets by id and returns undefined otherwise", () => {
    expect(getPreset("deepseek")?.protocol).toBe("deepseek")
    expect(getPreset("nope")).toBeUndefined()
  })
})

describe("ProviderRegistry", () => {
  let store: Store
  let credentials: CredentialStore
  let warnings: string[]
  let registry: ProviderRegistry

  beforeEach(async () => {
    store = await Store.open({ path: ":memory:" })
    credentials = new CredentialStore({ driver: store.driver })
    warnings = []
    registry = new ProviderRegistry({
      store,
      credentials,
      appId: "t02-app",
      onWarn: (message) => warnings.push(message),
    })
  })

  afterEach(() => {
    store.close()
  })

  it("completes protocol, npmPackage, baseUrl and name from the preset", () => {
    const record = registry.add({ id: "ds", presetId: "deepseek" })
    expect(record.protocol).toBe("deepseek")
    expect(record.npmPackage).toBe("@ai-sdk/deepseek")
    expect(record.baseUrl).toBe("https://api.deepseek.com/v1")
    expect(record.name).toBe("DeepSeek")
    expect(record.appId).toBe("t02-app")
    expect(record.enabled).toBe(true)
  })

  it("lets an explicit value win over the preset", () => {
    const record = registry.add({
      id: "ds-proxy",
      presetId: "deepseek",
      baseUrl: "http://127.0.0.1:4321/v1",
      name: "DeepSeek via proxy",
    })
    expect(record.baseUrl).toBe("http://127.0.0.1:4321/v1")
    expect(record.name).toBe("DeepSeek via proxy")
    expect(record.protocol).toBe("deepseek")
  })

  it("treats a bare baseUrl as openai-compatible", () => {
    const record = registry.add({ id: "local", baseUrl: "http://127.0.0.1:11434/v1" })
    expect(record.protocol).toBe("openai-compatible")
    expect(record.npmPackage).toBe("@ai-sdk/openai-compatible")
    expect(record.baseUrl).toBe("http://127.0.0.1:11434/v1")
    expect(record.name).toBe("local")
  })

  it("refuses a provider with neither preset, protocol nor baseUrl", () => {
    expectErrorCode(() => registry.add({ id: "mystery" }), "INVALID_REQUEST")
    expect(registry.list()).toHaveLength(0)
  })

  it("refuses an unknown preset id", () => {
    expectErrorCode(() => registry.add({ id: "x", presetId: "not-a-preset" }), "INVALID_REQUEST")
  })

  it("upserts: a second add() updates the record and keeps createdAt", () => {
    const first = registry.add({ id: "oa", presetId: "openai" })
    const second = registry.add({ id: "oa", presetId: "openai", name: "OpenAI (renamed)" })
    expect(second.name).toBe("OpenAI (renamed)")
    expect(second.createdAt).toBe(first.createdAt)
    expect(registry.list()).toHaveLength(1)
  })

  it("lists, gets, disables and removes providers", () => {
    registry.add({ id: "a", presetId: "openai" })
    registry.add({ id: "b", presetId: "xai" })

    expect(registry.list().map((record) => record.id)).toEqual(["a", "b"])
    expect(registry.get("a")?.protocol).toBe("openai")
    expect(registry.get("zzz")).toBeNull()

    registry.setEnabled("a", false)
    expect(registry.get("a")?.enabled).toBe(false)

    expect(registry.remove("a")).toBe(true)
    expect(registry.remove("a")).toBe(false)
    expect(registry.list().map((record) => record.id)).toEqual(["b"])
  })

  it("resolves the API key through the credential store", () => {
    process.env.MIK_T02_KEY = "sk-registry-abcdefgh"
    try {
      registry.add({ id: "oa", presetId: "openai", apiKeyRef: "env:MIK_T02_KEY" })
      const resolved = registry.resolve("oa")
      expect(resolved.apiKey).toBe("sk-registry-abcdefgh")
      expect(resolved.apiKeySource).toBe("ref")
      expect(resolved.protocol).toBe("openai")
      expect(resolved.npmPackage).toBe("@ai-sdk/openai")
      expect(resolved.baseUrl).toBe("https://api.openai.com/v1")
      expect(resolved.record.id).toBe("oa")
    } finally {
      delete process.env.MIK_T02_KEY
    }
  })

  it("reports a missing secret as CREDENTIAL", () => {
    registry.add({ id: "oa", presetId: "openai", apiKeyRef: "env:MIK_T02_MISSING_KEY" })
    expectErrorCode(() => registry.resolve("oa"), "CREDENTIAL")
  })

  it("reports an unknown provider as PROVIDER_NOT_FOUND", () => {
    expectErrorCode(() => registry.resolve("ghost"), "PROVIDER_NOT_FOUND")
  })

  // B2: no apiKeyRef + a preset that names a conventional env var → use it.
  it("falls back to the preset's environment variable when no apiKeyRef is set", () => {
    withEnv("XAI_API_KEY", "sk-env-fallback-abcdefgh", () => {
      registry.add({ id: "xai-env", presetId: "xai" })
      const resolved = registry.resolve("xai-env")
      expect(resolved.apiKey).toBe("sk-env-fallback-abcdefgh")
      expect(resolved.apiKeySource).toBe("env")
      expect(resolved.protocol).toBe("xai")
      expect(resolved.baseUrl).toBe("https://api.x.ai/v1")
    })
  })

  // B2: the fallback found nothing, but the preset says a key is required.
  it("fails with CREDENTIAL and an actionable hint when the preset env var is unset", () => {
    withEnv("XAI_API_KEY", undefined, () => {
      registry.add({ id: "xai-missing", presetId: "xai" })
      expectErrorCode(() => registry.resolve("xai-missing"), "CREDENTIAL")
      const error = (() => {
        try {
          registry.resolve("xai-missing")
          return null
        } catch (caught) {
          return caught as ModelInfraError
        }
      })()
      expect(error?.message).toBe(
        'Provider "xai-missing" has no API key. Set XAI_API_KEY or configure apiKeyRef for this provider.',
      )
      expect(error?.providerId).toBe("xai-missing")
    })
  })

  it("prefers an explicit apiKeyRef over the preset environment variable", () => {
    withEnv("XAI_API_KEY", "sk-from-preset-env", () => {
      process.env.MIK_T02_REF_KEY = "sk-from-explicit-ref"
      try {
        registry.add({ id: "xai-ref", presetId: "xai", apiKeyRef: "env:MIK_T02_REF_KEY" })
        const resolved = registry.resolve("xai-ref")
        expect(resolved.apiKey).toBe("sk-from-explicit-ref")
        expect(resolved.apiKeySource).toBe("ref")
      } finally {
        delete process.env.MIK_T02_REF_KEY
      }
    })
  })

  it("returns a null key with source none when no credential reference is configured", () => {
    registry.add({ id: "local", baseUrl: "http://127.0.0.1:1234/v1" })
    const resolved = registry.resolve("local")
    expect(resolved.apiKey).toBeNull()
    expect(resolved.apiKeySource).toBe("none")
    expect(resolved.baseUrl).toBe("http://127.0.0.1:1234/v1")
  })

  it("treats a preset without an envKey as keyless instead of failing", () => {
    registry.add({ id: "local-compat", presetId: "custom-openai-compatible" })
    const resolved = registry.resolve("local-compat")
    expect(resolved.apiKey).toBeNull()
    expect(resolved.apiKeySource).toBe("none")
  })

  // S8: `:` separates provider from model in a ref, so it cannot appear in an id.
  it("refuses a provider id containing the provider:model separator", () => {
    expectErrorCode(() => registry.add({ id: "my:proxy", baseUrl: "http://127.0.0.1:1234/v1" }), "INVALID_REQUEST")
    expect(registry.list()).toHaveLength(0)
  })

  it("refuses empty and over-long provider ids", () => {
    expectErrorCode(() => registry.add({ id: "", baseUrl: "http://127.0.0.1:1234/v1" }), "INVALID_REQUEST")
    expectErrorCode(() => registry.add({ id: "a".repeat(65), baseUrl: "http://127.0.0.1:1234/v1" }), "INVALID_REQUEST")
    expect(registry.list()).toHaveLength(0)
  })

  it("accepts ids made of the allowed characters", () => {
    const record = registry.add({ id: "my-proxy.v2_1", baseUrl: "http://127.0.0.1:1234/v1" })
    expect(record.id).toBe("my-proxy.v2_1")
    expect(registry.add({ id: "a".repeat(64), baseUrl: "http://127.0.0.1:1234/v1" }).id).toHaveLength(64)
  })

  it("seeds providers idempotently", () => {
    const configs: ProviderConfig[] = [
      { id: "seed-a", presetId: "openai" },
      { id: "seed-b", presetId: "anthropic" },
    ]
    registry.seed(configs)
    const first = registry.get("seed-a")!.createdAt
    registry.seed(configs)
    expect(registry.list().map((record) => record.id)).toEqual(["seed-a", "seed-b"])
    expect(registry.get("seed-a")?.createdAt).toBe(first)
    expect(warnings).toHaveLength(0)
  })

  it("warns instead of throwing when a seeded provider is invalid", () => {
    registry.seed([{ id: "broken" }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("broken")
    expect(registry.list()).toHaveLength(0)
  })

  it("round-trips the default model through settings", () => {
    registry.add({ id: "deepseek", presetId: "deepseek" })
    registry.add({ id: "openai", presetId: "openai" })
    expect(registry.defaultModel()).toBeNull()
    registry.setDefaultModel("deepseek:deepseek-chat")
    expect(registry.defaultModel()).toBe("deepseek:deepseek-chat")
    expect(store.settings.get(DEFAULT_MODEL_SETTING)).toBe("deepseek:deepseek-chat")
    registry.setDefaultModel("  openai:gpt-4o-mini  ")
    expect(registry.defaultModel()).toBe("openai:gpt-4o-mini")
  })

  it("rejects a malformed default model", () => {
    expect(() => registry.setDefaultModel("gpt-4o-mini")).toThrowError(ModelInfraError)
    expect(() => registry.setDefaultModel("deepseek:")).toThrowError(ModelInfraError)
    expect(registry.defaultModel()).toBeNull()
  })

  // S8: a default pointing at a provider that does not exist is a dead setting.
  it("refuses a default model whose provider is not configured", () => {
    expectErrorCode(() => registry.setDefaultModel("ghost:m"), "PROVIDER_NOT_FOUND")
    expect(registry.defaultModel()).toBeNull()
  })

  it("splits provider:model refs on the first separator only", () => {
    expect(splitModelRef("openrouter:meta/llama-3:free")).toEqual({
      providerId: "openrouter",
      modelId: "meta/llama-3:free",
    })
    expect(splitModelRef("nope")).toBeNull()
    expect(splitModelRef(":model")).toBeNull()
  })
})
