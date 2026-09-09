import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { createTestServer } from "@ai-sdk/test-server"
import { generateText } from "ai"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createAiBridge, type AiBridge } from "../src/ai/bridge.js"
import { CredentialStore } from "../src/credential/store.js"
import { ModelInfraError } from "../src/errors.js"
import { ProviderRegistry } from "../src/registry/registry.js"
import { Store } from "../src/store/database.js"
import type { ProviderStatus } from "../src/types.js"

const TEST_KEY = "sk-bridge-testkey-1234"

const OPENAI_MODELS = {
  object: "list",
  data: [
    { id: "mock-chat", object: "model", created: 1, owned_by: "mock" },
    { id: "mock-chat-mini", object: "model", created: 2, owned_by: "mock" },
    { id: "text-embedding-mock", object: "model", created: 3, owned_by: "mock" },
  ],
}

const CHAT_COMPLETION = {
  id: "chatcmpl-mock",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "mock-chat",
  choices: [{ index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
}

const server = createTestServer({
  "https://mock-openai.test/v1/models": { response: { type: "json-value", body: OPENAI_MODELS } },
  "https://mock-openai.test/v1/chat/completions": { response: { type: "json-value", body: CHAT_COMPLETION } },
  "https://mock-openai.test/v1/bad-key/models": {
    response: {
      type: "error",
      status: 401,
      body: JSON.stringify({ error: { message: `invalid api key ${TEST_KEY}` } }),
    },
  },
  "https://mock-openai.test/v1/forbidden/models": {
    response: { type: "error", status: 403, body: "forbidden upstream detail that must stay private" },
  },
  "https://mock-openai.test/v1/broken/models": { response: { type: "error", status: 500, body: "upstream exploded" } },
  "https://mock-anthropic.test/v1/models": {
    response: {
      type: "json-value",
      body: { data: [{ id: "claude-mock", type: "model", display_name: "Claude Mock" }] },
    },
  },
  "https://mock-google.test/v1beta/models": {
    response: {
      type: "json-value",
      body: {
        models: [
          {
            name: "models/gemini-mock",
            displayName: "Gemini Mock",
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 8_192,
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/gemini-embed",
            displayName: "Gemini Embedding",
            inputTokenLimit: 2_048,
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      },
    },
  },
})

/** The AI SDK's `LanguageModel` is a union with string ids; inspect it structurally. */
function describeModel(model: unknown): { modelId: string; provider: string; specificationVersion: string; doGenerate: unknown } {
  return model as { modelId: string; provider: string; specificationVersion: string; doGenerate: unknown }
}

/**
 * A real local server that accepts the connection and never answers, used to
 * prove that the bridge times a hanging provider out instead of waiting forever.
 * (The msw-backed test server cannot express a hang: its routes are structured
 * cloned, so a never-ending stream controller is not a supported response.)
 */
let hangServer: Server
let hangBaseUrl = ""
const hangSockets = new Set<Socket>()

beforeAll(async () => {
  server.server.start()
  process.env.MIK_T02_BRIDGE_KEY = TEST_KEY

  hangServer = createServer(() => {
    /* deliberately never respond */
  })
  hangServer.on("connection", (socket) => hangSockets.add(socket))
  await new Promise<void>((resolve) => hangServer.listen(0, "127.0.0.1", resolve))
  const address = hangServer.address() as AddressInfo
  hangBaseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  server.server.stop()
  delete process.env.MIK_T02_BRIDGE_KEY
  for (const socket of hangSockets) socket.destroy()
  await new Promise<void>((resolve) => hangServer.close(() => resolve()))
})

describe("createAiBridge", () => {
  let store: Store
  let registry: ProviderRegistry
  let bridge: AiBridge
  let warnings: string[]

  beforeEach(async () => {
    server.server.reset()
    store = await Store.open({ path: ":memory:" })
    warnings = []
    registry = new ProviderRegistry({
      store,
      credentials: new CredentialStore({ driver: store.driver }),
      appId: "t02-app",
      onWarn: (message) => warnings.push(message),
    })
    bridge = createAiBridge({ registry, onWarn: (message) => warnings.push(message) })

    const base = { apiKeyRef: "env:MIK_T02_BRIDGE_KEY", enabled: true }
    registry.add({ ...base, id: "mock-openai", baseUrl: "https://mock-openai.test/v1" })
    registry.add({ ...base, id: "mock-anthropic", protocol: "anthropic", baseUrl: "https://mock-anthropic.test/v1" })
    registry.add({ ...base, id: "mock-google", protocol: "google", baseUrl: "https://mock-google.test/v1beta" })
    registry.add({ ...base, id: "mock-bad-key", baseUrl: "https://mock-openai.test/v1/bad-key" })
    registry.add({ ...base, id: "mock-forbidden", baseUrl: "https://mock-openai.test/v1/forbidden" })
    registry.add({ ...base, id: "mock-broken", baseUrl: "https://mock-openai.test/v1/broken" })
    registry.add({
      ...base,
      id: "mock-slow",
      baseUrl: hangBaseUrl,
      meta: { timeoutMs: 150 },
    })
    // A local endpoint that needs no key at all: apiKeySource stays "none".
    registry.add({ id: "mock-no-key", baseUrl: "https://mock-openai.test/v1/bad-key" })
  })

  afterEach(() => {
    store.close()
  })

  describe("languageModel", () => {
    it("resolves provider:model into an AI SDK LanguageModel", async () => {
      const model = describeModel(await bridge.languageModel("mock-openai", "mock-chat"))
      expect(model.modelId).toBe("mock-chat")
      expect(model.provider).toBe("mock-openai.chat")
      expect(model.specificationVersion).toBe("v4")
      expect(typeof model.doGenerate).toBe("function")
    })

    it("returns a model the AI SDK can actually call", async () => {
      const model = await bridge.languageModel("mock-openai", "mock-chat")
      const result = await generateText({ model, prompt: "say hello" })
      expect(result.text).toBe("hello from mock")
      expect(result.finishReason).toBe("stop")
      expect(result.usage.inputTokens).toBe(5)

      const call = server.calls.find((entry) => entry.requestUrl.endsWith("/chat/completions"))
      expect(call).toBeDefined()
      expect(call!.requestMethod).toBe("POST")
      expect(call!.requestHeaders.authorization).toBe(`Bearer ${TEST_KEY}`)
    })

    it("names the model after the configured provider id", async () => {
      const first = describeModel(await bridge.languageModel("mock-openai", "mock-chat"))
      const second = describeModel(await bridge.languageModel("mock-openai", "mock-chat-mini"))
      expect(first.provider).toBe("mock-openai.chat")
      expect(second.provider).toBe("mock-openai.chat")
      expect(second.modelId).toBe("mock-chat-mini")
    })

    it("throws PROVIDER_NOT_FOUND for an unknown provider", async () => {
      await expect(bridge.languageModel("ghost", "m")).rejects.toBeInstanceOf(ModelInfraError)
      await expect(bridge.languageModel("ghost", "m")).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" })
    })

    it("throws CREDENTIAL when the referenced secret is missing", async () => {
      registry.add({ id: "no-secret", presetId: "openai", apiKeyRef: "env:MIK_T02_NOT_SET" })
      await expect(bridge.languageModel("no-secret", "gpt-4o-mini")).rejects.toMatchObject({ code: "CREDENTIAL" })
    })
  })

  describe("test", () => {
    it("reports a healthy provider with its model count", async () => {
      const status = await bridge.test("mock-openai")
      expect(status.ok).toBe(true)
      expect(status.providerId).toBe("mock-openai")
      expect(status.modelCount).toBe(3)
      expect(status.message).toContain("Connected")
      expect(status.latencyMs).toBeGreaterThanOrEqual(0)
      expect(typeof status.checkedAt).toBe("number")
      expect(status.message).not.toContain(TEST_KEY)
    })

    // S9: an auth failure must not echo the upstream body — it contains the key.
    it("reports a rejected key without leaking it or the upstream body", async () => {
      const status = await bridge.test("mock-bad-key")
      expect(status.ok).toBe(false)
      expect(status.message).toContain("API key rejected")
      expect(status.message).toContain("401")
      expect(status.message).not.toContain(TEST_KEY)
      expect(status.message).not.toContain("sk-****")
      expect(status.message).not.toContain("invalid api key")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).not.toContain(TEST_KEY)
      expect(warnings[0]).not.toContain("invalid api key")
    })

    it("keeps the upstream body out of a 403 as well", async () => {
      const status = await bridge.test("mock-forbidden")
      expect(status.ok).toBe(false)
      expect(status.message).toContain("403")
      expect(status.message).toContain("API key rejected")
      expect(status.message).not.toContain("forbidden upstream detail")
    })

    // B2: a provider that never had a key must not be told its key was rejected.
    it("does not blame a missing key for a provider configured without one", async () => {
      const resolved = registry.resolve("mock-no-key")
      expect(resolved.apiKey).toBeNull()
      expect(resolved.apiKeySource).toBe("none")

      const status = await bridge.test("mock-no-key")
      expect(status.ok).toBe(false)
      expect(status.message).toContain("401")
      expect(status.message).toMatch(/without an API key/i)
      expect(status.message).not.toMatch(/api key rejected/i)
      expect(status.message).not.toContain(TEST_KEY)
    })

    it("reports a server error", async () => {
      const status = await bridge.test("mock-broken")
      expect(status.ok).toBe(false)
      expect(status.message).toContain("500")
      expect(status.message).toContain("upstream exploded")
    })

    it("gives up on a hanging provider instead of hanging forever", async () => {
      // msw only intercepts registered URLs; stop it so the request really
      // reaches the hanging socket instead of being reported as unhandled.
      server.server.stop()
      try {
        const started = Date.now()
        const status = await bridge.test("mock-slow")
        expect(status.ok).toBe(false)
        expect(status.message).toMatch(/did not respond in time/i)
        expect(Date.now() - started).toBeLessThan(5_000)
      } finally {
        server.server.start()
      }
    })

    it("never throws for an unknown provider", async () => {
      const status: ProviderStatus = await bridge.test("ghost")
      expect(status.ok).toBe(false)
      expect(status.message).toContain("not configured")
    })

    it("explains a provider that has no base URL", async () => {
      registry.add({ id: "no-url", protocol: "openai-compatible" })
      const status = await bridge.test("no-url")
      expect(status.ok).toBe(false)
      expect(status.message).toMatch(/base URL/i)
    })
  })

  describe("discoverModels", () => {
    it("returns provider_api models for an OpenAI-compatible provider", async () => {
      const models = await bridge.discoverModels("mock-openai")
      expect(models.map((model) => model.modelId)).toEqual(["mock-chat", "mock-chat-mini", "text-embedding-mock"])
      expect(models[0]!.ref).toBe("mock-openai:mock-chat")
      expect(models[0]!.source).toBe("provider_api")
      expect(models[0]!.capabilities.text).toBe(true)
      expect(models[2]!.capabilities.text).toBe(false)
      expect(typeof models[0]!.syncedAt).toBe("number")
      expect(warnings).toHaveLength(0)
    })

    it("uses the anthropic protocol adapter and its auth header", async () => {
      const models = await bridge.discoverModels("mock-anthropic")
      expect(models).toHaveLength(1)
      expect(models[0]!.modelId).toBe("claude-mock")
      expect(models[0]!.displayName).toBe("Claude Mock")

      const call = server.calls.find((entry) => entry.requestUrl.startsWith("https://mock-anthropic.test"))
      expect(call!.requestHeaders["x-api-key"]).toBe(TEST_KEY)
      expect(call!.requestHeaders["anthropic-version"]).toBe("2023-06-01")
    })

    it("uses the google protocol adapter and strips the models/ prefix", async () => {
      const models = await bridge.discoverModels("mock-google")
      expect(models.map((model) => model.modelId)).toEqual(["gemini-mock", "gemini-embed"])
      expect(models[0]!.contextWindow).toBe(1_048_576)
      expect(models[0]!.maxOutputTokens).toBe(8_192)
      expect(models[1]!.capabilities.text).toBe(false)

      const call = server.calls.find((entry) => entry.requestUrl.startsWith("https://mock-google.test"))
      expect(call!.requestHeaders["x-goog-api-key"]).toBe(TEST_KEY)
    })

    it("returns [] and warns when the provider fails", async () => {
      const models = await bridge.discoverModels("mock-broken")
      expect(models).toEqual([])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("mock-broken")
    })

    it("returns [] for an unknown provider without throwing", async () => {
      await expect(bridge.discoverModels("ghost")).resolves.toEqual([])
      expect(warnings).toHaveLength(1)
    })
  })

  describe("protocol dispatch", () => {
    it("keeps every protocol in the table", async () => {
      const { SDK_PROTOCOLS, MODEL_LIST_PROTOCOLS } = await import("../src/ai/protocols.js")
      const protocols = ["openai", "anthropic", "google", "deepseek", "moonshotai", "xai", "openai-compatible"]
      expect(Object.keys(SDK_PROTOCOLS).sort()).toEqual([...protocols].sort())
      expect(Object.keys(MODEL_LIST_PROTOCOLS).sort()).toEqual([...protocols].sort())
    })

    it("selects the protocol by data, never by provider id", () => {
      const files = ["../src/ai/bridge.ts", "../src/ai/protocols.ts", "../src/registry/registry.ts"]
      for (const file of files) {
        const source = readFileSync(new URL(file, import.meta.url), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "")
        expect(source).not.toMatch(/providerId\s*===/)
        expect(source).not.toMatch(/(id|provider)\s*===\s*["'](openai|anthropic|google|deepseek|moonshotai|xai|openrouter)["']/)
      }
    })

    // S11: every SDK protocol must be able to build a model object offline.
    it("builds a model for each of the six SDK protocols with the right options", async () => {
      const { SDK_PROTOCOLS, loadProviderFactory } = await import("../src/ai/protocols.js")
      const protocols = ["openai", "anthropic", "google", "deepseek", "moonshotai", "xai"] as const

      for (const protocol of protocols) {
        const id = `opt-${protocol}`
        registry.add({
          id,
          presetId: protocol,
          apiKeyRef: "env:MIK_T02_BRIDGE_KEY",
          headers: { "x-mik-test": protocol },
        })
        const resolved = registry.resolve(id)
        expect(resolved.protocol).toBe(protocol)
        expect(resolved.apiKeySource).toBe("ref")

        const options = SDK_PROTOCOLS[protocol].factoryOptions(resolved)
        expect(options.apiKey).toBe(TEST_KEY)
        expect(options.baseURL).toBe(resolved.baseUrl)
        expect(options.headers).toEqual({ "x-mik-test": protocol })

        const factory = await loadProviderFactory(protocol)
        const provider = factory(options) as { languageModel(modelId: string): unknown }
        const model = describeModel(provider.languageModel("mock-model"))
        expect(model.modelId).toBe("mock-model")
        expect(model.specificationVersion).toBe("v4")
        expect(typeof model.doGenerate).toBe("function")
      }
    })

    it("omits the headers option when the provider declares none", async () => {
      const { SDK_PROTOCOLS } = await import("../src/ai/protocols.js")
      registry.add({ id: "opt-plain", presetId: "deepseek", apiKeyRef: "env:MIK_T02_BRIDGE_KEY" })
      const options = SDK_PROTOCOLS.deepseek.factoryOptions(registry.resolve("opt-plain"))
      expect(options.headers).toBeUndefined()
    })

    // S11: the optional peer packages are loaded lazily, so a missing one has to
    // become an actionable install hint rather than a startup crash.
    it("explains a missing provider package with an install hint", async () => {
      const { SDK_PROTOCOLS, loadProviderFactory } = await import("../src/ai/protocols.js")
      const original = SDK_PROTOCOLS.openai
      SDK_PROTOCOLS.openai = { ...original, npmPackage: "@ai-sdk/mik-package-that-does-not-exist" }
      try {
        const failure = await loadProviderFactory("openai").then(
          () => null,
          (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(ModelInfraError)
        const mapped = failure as ModelInfraError
        expect(mapped.code).toBe("PROVIDER")
        expect(mapped.message).toContain("npm i @ai-sdk/mik-package-that-does-not-exist")
      } finally {
        SDK_PROTOCOLS.openai = original
      }
    })
  })
})
