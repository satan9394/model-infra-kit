import type { ModelMetadata, ProviderModelBinding } from "./types.js"

/** Snapshot source: models.dev, checked 2026-09-23. */
export const MODEL_CATALOG_SOURCE = "https://models.dev/api.json"

/**
 * Canonical model facts are taken from the publisher's models.dev records.
 * Endpoint names and availability live in `PROVIDER_MODEL_BINDINGS` below.
 * The legacy Claude 3.5 record is retained with its published limits and only
 * has a deprecated endpoint binding.
 */
export const MODEL_METADATA: readonly ModelMetadata[] = [
  {
    id: "gpt-6-astra",
    family: "gpt-6",
    name: "GPT-6 Astra",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: { reasoning: true, vision: true, tools: true, structuredOutputs: true },
    source: "models.dev",
    sourceUrl: MODEL_CATALOG_SOURCE,
    sourceProviderId: "openai",
  },
  {
    id: "gpt-6-luna",
    family: "gpt-6",
    name: "GPT-6 Luna",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: { reasoning: true, vision: true, tools: true, structuredOutputs: true },
    source: "models.dev",
    sourceUrl: MODEL_CATALOG_SOURCE,
    sourceProviderId: "openai",
  },
  {
    id: "gpt-6-sol",
    family: "gpt-6",
    name: "GPT-6 Sol",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: { reasoning: true, vision: true, tools: true, structuredOutputs: true },
    source: "models.dev",
    sourceUrl: MODEL_CATALOG_SOURCE,
    sourceProviderId: "openai",
  },
  {
    id: "claude-3-5-sonnet",
    family: "claude-3.5",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: { reasoning: false, vision: true, tools: true, structuredOutputs: false },
    source: "Anthropic model documentation (legacy)",
    sourceUrl: "https://docs.anthropic.com/en/docs/about-claude/models/all-models",
  },
  {
    id: "claude-opus-5",
    family: "claude-opus",
    name: "Claude Opus 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: { reasoning: true, vision: true, tools: true, structuredOutputs: true },
    source: "models.dev",
    sourceUrl: MODEL_CATALOG_SOURCE,
    sourceProviderId: "anthropic",
  },
  {
    id: "deepseek-r1",
    family: "deepseek-r1",
    name: "DeepSeek-R1",
    contextWindow: 64_000,
    maxOutputTokens: 16_000,
    capabilities: { reasoning: true, vision: false, tools: true, structuredOutputs: false },
    source: "models.dev",
    sourceUrl: MODEL_CATALOG_SOURCE,
    sourceProviderId: "openrouter",
  },
  {
    id: "deepseek-v3",
    family: "deepseek-v3",
    name: "DeepSeek V3",
    contextWindow: 163_840,
    maxOutputTokens: 147_456,
    capabilities: { reasoning: false, vision: false, tools: true, structuredOutputs: true },
    source: "models.dev",
    sourceUrl: MODEL_CATALOG_SOURCE,
    sourceProviderId: "openrouter",
  },
]

/**
 * Explicit endpoint aliases are data, not provider-specific branches. The
 * canonical model facts above never inherit a provider's endpoint identifier.
 */
export const PROVIDER_MODEL_BINDINGS: readonly ProviderModelBinding[] = [
  { providerId: "openai", protocol: "openai", modelId: "gpt-6-astra", upstreamModelName: "gpt-6-astra", status: "available" },
  { providerId: "openai", protocol: "openai", modelId: "gpt-6-luna", upstreamModelName: "gpt-6-luna", status: "available" },
  { providerId: "openai", protocol: "openai", modelId: "gpt-6-sol", upstreamModelName: "gpt-6-sol", status: "available" },
  { providerId: "openrouter", protocol: "openai-compatible", modelId: "gpt-6-astra", upstreamModelName: "openai/gpt-6-astra", status: "available" },
  { providerId: "openrouter", protocol: "openai-compatible", modelId: "gpt-6-luna", upstreamModelName: "openai/gpt-6-luna", status: "available" },
  { providerId: "openrouter", protocol: "openai-compatible", modelId: "gpt-6-sol", upstreamModelName: "openai/gpt-6-sol", status: "available" },
  {
    providerId: "anthropic",
    protocol: "anthropic",
    modelId: "claude-3-5-sonnet",
    upstreamModelName: "claude-3-5-sonnet-20241022",
    status: "deprecated",
  },
  { providerId: "anthropic", protocol: "anthropic", modelId: "claude-opus-5", upstreamModelName: "claude-opus-5", status: "available" },
  {
    providerId: "openrouter",
    protocol: "openai-compatible",
    modelId: "claude-opus-5",
    upstreamModelName: "anthropic/claude-opus-5",
    status: "available",
  },
  {
    providerId: "openrouter",
    protocol: "openai-compatible",
    modelId: "deepseek-r1",
    upstreamModelName: "deepseek/deepseek-r1",
    status: "available",
  },
  {
    providerId: "openrouter",
    protocol: "openai-compatible",
    modelId: "deepseek-v3",
    upstreamModelName: "deepseek/deepseek-chat-v3-0324",
    status: "available",
  },
]
