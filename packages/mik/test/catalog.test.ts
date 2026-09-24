import { describe, expect, it } from "vitest"
import { main } from "../src/cli/index.js"
import { parseCliArgs } from "../src/cli/args.js"
import {
  ModelCatalogService,
  type ModelMetadata,
  type ProviderModelBinding,
} from "../src/catalog/index.js"

const MODELS: readonly ModelMetadata[] = [
  {
    id: "gpt-6-luna",
    family: "gpt-6",
    name: "GPT-6 Luna",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: { reasoning: true, vision: true, tools: true, structuredOutputs: true },
    source: "models.dev",
    sourceUrl: "https://models.dev/api.json",
  },
  {
    id: "text-basic",
    family: "text",
    name: "Text Basic",
    contextWindow: 32_000,
    capabilities: { reasoning: false, vision: false, tools: false, structuredOutputs: false },
    source: "models.dev",
    sourceUrl: "https://models.dev/api.json",
  },
]

const BINDINGS: readonly ProviderModelBinding[] = [
  { providerId: "openai", protocol: "openai", modelId: "gpt-6-luna", upstreamModelName: "gpt-6-luna", status: "available" },
  { providerId: "azure-prod", protocol: "openai", modelId: "gpt-6-luna", upstreamModelName: "luna-deployment", status: "preview" },
  { providerId: "openai", protocol: "openai", modelId: "text-basic", upstreamModelName: "text-basic", status: "deprecated" },
]

describe("ModelCatalogService", () => {
  it("filters model facts by family, capability and provider binding", () => {
    const catalog = new ModelCatalogService({ models: MODELS, bindings: BINDINGS })

    expect(catalog.list({ family: "gpt-6" }).map((model) => model.id)).toEqual(["gpt-6-luna"])
    expect(catalog.list({ capability: "vision" }).map((model) => model.id)).toEqual(["gpt-6-luna"])
    expect(catalog.list({ providerId: "azure-prod" }).map((model) => model.id)).toEqual(["gpt-6-luna"])
    expect(catalog.list({ protocol: "openai-compatible" })).toEqual([])
    expect(catalog.list({ providerId: "azure-prod", status: "preview" }).map((model) => model.id)).toEqual(["gpt-6-luna"])
    expect(catalog.list({ providerId: "missing" })).toEqual([])
  })

  it("resolves the selected provider's upstream endpoint without changing model facts", () => {
    const catalog = new ModelCatalogService({ models: MODELS, bindings: BINDINGS })

    expect(catalog.resolveEndpoint("gpt-6-luna", "azure-prod")).toEqual(BINDINGS[1])
    expect(catalog.resolveEndpoint("gpt-6-luna", "unknown-provider")).toBeUndefined()
    expect(catalog.get("gpt-6-luna")?.id).toBe("gpt-6-luna")
    expect(catalog.get("gpt-6-luna")?.id).not.toBe("luna-deployment")
  })

  it("resolves configured provider ids through their preset only when the protocol agrees", () => {
    const catalog = new ModelCatalogService({
      models: MODELS,
      bindings: BINDINGS,
      providerLookup: (providerId) =>
        providerId === "prod-openai"
          ? { id: providerId, presetId: "openai", protocol: "openai", enabled: true }
          : providerId === "wrong-protocol"
            ? { id: providerId, presetId: "openai", protocol: "openai-compatible", enabled: true }
            : null,
    })

    expect(catalog.resolveEndpoint("gpt-6-luna", "prod-openai")).toMatchObject({
      providerId: "prod-openai",
      upstreamModelName: "gpt-6-luna",
    })
    expect(catalog.resolveEndpoint("gpt-6-luna", "wrong-protocol")).toBeUndefined()
  })

  it("rejects unsupported capability guards and unknown model ids", () => {
    const catalog = new ModelCatalogService({ models: MODELS, bindings: BINDINGS })

    let unsupported: unknown
    let missing: unknown
    try {
      catalog.assertCapability("text-basic", "vision")
    } catch (error) {
      unsupported = error
    }
    try {
      catalog.assertCapability("unknown-model", "tools")
    } catch (error) {
      missing = error
    }
    expect(unsupported).toMatchObject({ code: "INVALID_REQUEST", model: "text-basic" })
    expect(unsupported).toHaveProperty("message", 'Model "text-basic" does not support vision.')
    expect(missing).toMatchObject({ code: "MODEL_NOT_FOUND", model: "unknown-model" })
    expect(() => catalog.assertCapability("gpt-6-luna", "tools")).not.toThrow()
  })

  it("ships a static, provider-independent catalog snapshot with endpoint bindings", async () => {
    const { modelCatalog } = await import("../src/catalog/index.js")
    const luna = modelCatalog.get("gpt-6-luna")
    const opus = modelCatalog.get("claude-opus-5")
    const deepseek = modelCatalog.get("deepseek-r1")

    expect(luna).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      capabilities: { reasoning: true, vision: true, tools: true, structuredOutputs: true },
      source: "models.dev",
    })
    expect(opus?.contextWindow).toBe(1_000_000)
    expect(deepseek?.capabilities.reasoning).toBe(true)
    expect(modelCatalog.resolveEndpoint("gpt-6-luna", "openai")?.upstreamModelName).toBe("gpt-6-luna")
    expect(modelCatalog.resolveEndpoint("claude-opus-5", "openrouter")?.upstreamModelName).toBe(
      "anthropic/claude-opus-5",
    )
  })
})

describe("models catalog CLI", () => {
  it("adds catalog as an action and keeps the existing models command shape", () => {
    expect(parseCliArgs(["models", "catalog", "--json"]).action?.name).toBe("catalog")
    expect(parseCliArgs(["models", "--refresh"]).action).toBeNull()
    expect(parseCliArgs(["models", "list"]).action?.name).toBe("list")
  })

  it("prints localized tables and JSON without opening providers", async () => {
    const lines: string[] = []
    const jsonCode = await main(["models", "catalog", "--json"], {
      io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
      env: { MIK_LANG: "en" },
      interactive: false,
    })
    expect(jsonCode).toBe(0)
    const json = JSON.parse(lines.join("\n")) as { models: ModelMetadata[]; bindings: ProviderModelBinding[] }
    expect(json.models.some((model) => model.id === "gpt-6-luna")).toBe(true)
    expect(json.bindings.some((binding) => binding.providerId === "openrouter")).toBe(true)

    lines.length = 0
    const tableCode = await main(["models", "catalog"], {
      io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
      env: { MIK_LANG: "zh" },
      interactive: false,
    })
    expect(tableCode).toBe(0)
    expect(lines.join("\n")).toContain("模型 ID")
    expect(lines.join("\n")).toContain("推理")
    expect(lines.join("\n")).toContain("可用")
    expect(lines.join("\n")).toContain("gpt-6-luna")
    expect(lines.join("\n")).toContain("openai-compatible:openai/gpt-6-luna")

    lines.length = 0
    const helpCode = await main(["models", "catalog", "--help"], {
      io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
      env: { MIK_LANG: "zh" },
      interactive: false,
    })
    expect(helpCode).toBe(0)
    expect(lines.join("\n")).toContain("列出与供应商无关的模型事实和端点绑定")
    expect(lines.join("\n")).toContain("以 JSON 输出静态模型目录与端点绑定")
  })
})
