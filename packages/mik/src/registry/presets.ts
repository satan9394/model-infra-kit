import type { Protocol, ProviderPreset } from "../types.js"

/**
 * The `@ai-sdk/*` package that implements each protocol.
 *
 * This is the single source of truth for "protocol → package": the preset table
 * and the AI bridge both read it, so a protocol can never be wired to the wrong
 * implementation by hand.
 */
export const PROTOCOL_PACKAGES: Record<Protocol, string> = {
  openai: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
  google: "@ai-sdk/google",
  deepseek: "@ai-sdk/deepseek",
  moonshotai: "@ai-sdk/moonshotai",
  xai: "@ai-sdk/xai",
  "openai-compatible": "@ai-sdk/openai-compatible",
}

/**
 * Shipped provider presets. Adding a provider means adding a row here — never a
 * branch somewhere else in the code.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    npmPackage: PROTOCOL_PACKAGES.openai,
    envKey: "OPENAI_API_KEY",
    docUrl: "https://platform.openai.com/docs/api-reference",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    npmPackage: PROTOCOL_PACKAGES.anthropic,
    envKey: "ANTHROPIC_API_KEY",
    docUrl: "https://docs.anthropic.com/en/api/getting-started",
  },
  {
    id: "google",
    name: "Google Gemini",
    protocol: "google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    npmPackage: PROTOCOL_PACKAGES.google,
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    docUrl: "https://ai.google.dev/gemini-api/docs",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "deepseek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    npmPackage: PROTOCOL_PACKAGES.deepseek,
    envKey: "DEEPSEEK_API_KEY",
    docUrl: "https://api-docs.deepseek.com",
  },
  {
    id: "moonshotai",
    name: "Moonshot AI",
    protocol: "moonshotai",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    npmPackage: PROTOCOL_PACKAGES.moonshotai,
    envKey: "MOONSHOT_API_KEY",
    docUrl: "https://platform.moonshot.ai/docs",
  },
  {
    id: "xai",
    name: "xAI",
    protocol: "xai",
    defaultBaseUrl: "https://api.x.ai/v1",
    npmPackage: PROTOCOL_PACKAGES.xai,
    envKey: "XAI_API_KEY",
    docUrl: "https://docs.x.ai/docs/models",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    npmPackage: PROTOCOL_PACKAGES["openai-compatible"],
    envKey: "OPENROUTER_API_KEY",
    docUrl: "https://openrouter.ai/docs",
  },
  {
    id: "custom-openai-compatible",
    name: "Custom (OpenAI compatible)",
    protocol: "openai-compatible",
    npmPackage: PROTOCOL_PACKAGES["openai-compatible"],
    docUrl: "https://ai-sdk.dev/providers/openai-compatible-providers",
  },
]

const PRESETS_BY_ID: ReadonlyMap<string, ProviderPreset> = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]))

export function getPreset(id: string): ProviderPreset | undefined {
  return PRESETS_BY_ID.get(id)
}

/** The npm package that must be installed for a protocol to work. */
export function packageForProtocol(protocol: Protocol): string | undefined {
  return PROTOCOL_PACKAGES[protocol]
}
