import { ModelInfraError } from "../errors.js"
import { PROTOCOL_PACKAGES } from "../registry/presets.js"
import type { ResolvedProvider } from "../registry/registry.js"
import type { ModelCapabilities, Protocol } from "../types.js"

/** A `@ai-sdk/*` provider factory, loaded lazily so the packages stay optional. */
export type ProviderFactory = (options: Record<string, unknown>) => unknown

/** How to build the provider instance for a protocol. */
export interface SdkProtocol {
  npmPackage: string
  /** Export names to try in that package, first match wins. */
  factoryExports: readonly string[]
  /** Factory arguments derived from the resolved provider. */
  factoryOptions(resolved: ResolvedProvider): Record<string, unknown>
}

function headersOf(resolved: ResolvedProvider): Record<string, string> | undefined {
  return Object.keys(resolved.record.headers).length > 0 ? resolved.record.headers : undefined
}

function requireBaseUrl(resolved: ResolvedProvider): string {
  const base = resolved.baseUrl?.replace(/\/+$/, "")
  if (!base) {
    throw new ModelInfraError(
      `Provider "${resolved.record.id}" has no base URL. Set baseUrl or pick a preset that ships one.`,
      { code: "INVALID_REQUEST", providerId: resolved.record.id },
    )
  }
  return base
}

/**
 * Protocol → SDK factory. Every protocol is one row; there is deliberately no
 * `if (providerId === ...)` anywhere in this package.
 */
export const SDK_PROTOCOLS: Record<Protocol, SdkProtocol> = {
  openai: {
    npmPackage: PROTOCOL_PACKAGES.openai,
    factoryExports: ["createOpenAI"],
    factoryOptions: (resolved) => ({
      apiKey: resolved.apiKey ?? undefined,
      baseURL: resolved.baseUrl,
      headers: headersOf(resolved),
    }),
  },
  anthropic: {
    npmPackage: PROTOCOL_PACKAGES.anthropic,
    factoryExports: ["createAnthropic"],
    factoryOptions: (resolved) => ({
      apiKey: resolved.apiKey ?? undefined,
      baseURL: resolved.baseUrl,
      headers: headersOf(resolved),
    }),
  },
  google: {
    npmPackage: PROTOCOL_PACKAGES.google,
    factoryExports: ["createGoogleGenerativeAI", "createGoogle"],
    factoryOptions: (resolved) => ({
      apiKey: resolved.apiKey ?? undefined,
      baseURL: resolved.baseUrl,
      headers: headersOf(resolved),
    }),
  },
  deepseek: {
    npmPackage: PROTOCOL_PACKAGES.deepseek,
    factoryExports: ["createDeepSeek"],
    factoryOptions: (resolved) => ({
      apiKey: resolved.apiKey ?? undefined,
      baseURL: resolved.baseUrl,
      headers: headersOf(resolved),
    }),
  },
  moonshotai: {
    npmPackage: PROTOCOL_PACKAGES.moonshotai,
    factoryExports: ["createMoonshotAI"],
    factoryOptions: (resolved) => ({
      apiKey: resolved.apiKey ?? undefined,
      baseURL: resolved.baseUrl,
      headers: headersOf(resolved),
    }),
  },
  xai: {
    npmPackage: PROTOCOL_PACKAGES.xai,
    factoryExports: ["createXai"],
    factoryOptions: (resolved) => ({
      apiKey: resolved.apiKey ?? undefined,
      baseURL: resolved.baseUrl,
      headers: headersOf(resolved),
    }),
  },
  "openai-compatible": {
    npmPackage: PROTOCOL_PACKAGES["openai-compatible"],
    factoryExports: ["createOpenAICompatible"],
    factoryOptions: (resolved) => ({
      name: resolved.record.id,
      baseURL: requireBaseUrl(resolved),
      apiKey: resolved.apiKey ?? undefined,
      headers: headersOf(resolved),
    }),
  },
}

/**
 * Load the SDK factory for a protocol.
 *
 * The provider packages are optional peers, so they are imported at call time;
 * a missing package becomes an actionable error instead of a startup crash.
 */
export async function loadProviderFactory(protocol: Protocol): Promise<ProviderFactory> {
  const spec = SDK_PROTOCOLS[protocol]
  if (!spec) {
    throw new ModelInfraError(`Unsupported protocol "${String(protocol)}".`, { code: "PROVIDER" })
  }

  let module: Record<string, unknown>
  try {
    module = (await import(spec.npmPackage)) as Record<string, unknown>
  } catch (error) {
    throw new ModelInfraError(
      `Protocol "${protocol}" needs the optional package "${spec.npmPackage}". Install it with \`npm i ${spec.npmPackage}\`.`,
      { code: "PROVIDER", cause: error },
    )
  }

  for (const name of spec.factoryExports) {
    const factory = module[name]
    if (typeof factory === "function") return factory as ProviderFactory
  }

  throw new ModelInfraError(
    `Package "${spec.npmPackage}" does not export ${spec.factoryExports.map((name) => `"${name}"`).join(" or ")}.`,
    { code: "PROVIDER" },
  )
}

/** One model as reported by a provider's own list endpoint. */
export interface DiscoveredModel {
  modelId: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: Partial<ModelCapabilities>
}

/** How to list a provider's models over HTTP for a given protocol. */
export interface ModelListProtocol {
  url(resolved: ResolvedProvider): string
  headers(resolved: ResolvedProvider): Record<string, string>
  parse(payload: unknown): DiscoveredModel[]
  defaultCapabilities: ModelCapabilities
}

const TEXT_CAPABILITIES: ModelCapabilities = {
  text: true,
  image: false,
  toolCall: true,
  reasoning: false,
  structuredOutput: false,
}

const MULTIMODAL_CAPABILITIES: ModelCapabilities = {
  text: true,
  image: true,
  toolCall: true,
  reasoning: false,
  structuredOutput: false,
}

/** Model ids that are clearly not chat models, used to keep the catalogue honest. */
const NON_CHAT_MODEL = /(embedding|embed-|moderation|whisper|tts|audio|dall-e|rerank|transcribe|speech|sora|image)/i

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** `{ data: [{ id, name?, context_length? }] }` — OpenAI, DeepSeek, Moonshot, xAI, OpenRouter. */
function parseOpenAiStyleList(payload: unknown): DiscoveredModel[] {
  const rows = asArray(asRecord(payload)?.data)
  const models: DiscoveredModel[] = []
  for (const row of rows) {
    const entry = asRecord(row)
    const modelId = asString(entry?.id)
    if (!modelId) continue
    models.push({
      modelId,
      displayName: asString(entry?.name),
      contextWindow: asNumber(entry?.context_length) ?? asNumber(entry?.context_window),
      maxOutputTokens: asNumber(entry?.max_output_tokens),
      capabilities: NON_CHAT_MODEL.test(modelId) ? { text: false, toolCall: false } : undefined,
    })
  }
  return models
}

/** `{ data: [{ id, display_name }] }` — Anthropic's `/v1/models`. */
function parseAnthropicList(payload: unknown): DiscoveredModel[] {
  const rows = asArray(asRecord(payload)?.data)
  const models: DiscoveredModel[] = []
  for (const row of rows) {
    const entry = asRecord(row)
    const modelId = asString(entry?.id)
    if (!modelId) continue
    models.push({ modelId, displayName: asString(entry?.display_name) })
  }
  return models
}

/** `{ models: [{ name: "models/x", displayName, inputTokenLimit, supportedGenerationMethods }] }` — Google. */
function parseGoogleList(payload: unknown): DiscoveredModel[] {
  const rows = asArray(asRecord(payload)?.models)
  const models: DiscoveredModel[] = []
  for (const row of rows) {
    const entry = asRecord(row)
    const rawName = asString(entry?.name)
    if (!rawName) continue
    const modelId = rawName.replace(/^models\//, "")
    const methods = asArray(entry?.supportedGenerationMethods).filter((value): value is string => typeof value === "string")
    models.push({
      modelId,
      displayName: asString(entry?.displayName),
      contextWindow: asNumber(entry?.inputTokenLimit),
      maxOutputTokens: asNumber(entry?.outputTokenLimit),
      capabilities: methods.length > 0 && !methods.includes("generateContent") ? { text: false, toolCall: false } : undefined,
    })
  }
  return models
}

const BEARER = (resolved: ResolvedProvider): Record<string, string> =>
  resolved.apiKey ? { authorization: `Bearer ${resolved.apiKey}` } : {}

/** Protocol → model-list probe. Every protocol is one row, no provider branches. */
export const MODEL_LIST_PROTOCOLS: Record<Protocol, ModelListProtocol> = {
  openai: {
    url: (resolved) => `${requireBaseUrl(resolved)}/models`,
    headers: (resolved) => ({ accept: "application/json", ...BEARER(resolved) }),
    parse: parseOpenAiStyleList,
    defaultCapabilities: TEXT_CAPABILITIES,
  },
  deepseek: {
    url: (resolved) => `${requireBaseUrl(resolved)}/models`,
    headers: (resolved) => ({ accept: "application/json", ...BEARER(resolved) }),
    parse: parseOpenAiStyleList,
    defaultCapabilities: TEXT_CAPABILITIES,
  },
  moonshotai: {
    url: (resolved) => `${requireBaseUrl(resolved)}/models`,
    headers: (resolved) => ({ accept: "application/json", ...BEARER(resolved) }),
    parse: parseOpenAiStyleList,
    defaultCapabilities: TEXT_CAPABILITIES,
  },
  xai: {
    url: (resolved) => `${requireBaseUrl(resolved)}/models`,
    headers: (resolved) => ({ accept: "application/json", ...BEARER(resolved) }),
    parse: parseOpenAiStyleList,
    defaultCapabilities: TEXT_CAPABILITIES,
  },
  "openai-compatible": {
    url: (resolved) => `${requireBaseUrl(resolved)}/models`,
    headers: (resolved) => ({ accept: "application/json", ...BEARER(resolved) }),
    parse: parseOpenAiStyleList,
    defaultCapabilities: TEXT_CAPABILITIES,
  },
  anthropic: {
    url: (resolved) => `${requireBaseUrl(resolved)}/models`,
    headers: (resolved) => ({
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      ...(resolved.apiKey ? { "x-api-key": resolved.apiKey } : {}),
    }),
    parse: parseAnthropicList,
    defaultCapabilities: MULTIMODAL_CAPABILITIES,
  },
  google: {
    url: (resolved) => `${requireBaseUrl(resolved)}/models`,
    headers: (resolved) => ({
      accept: "application/json",
      ...(resolved.apiKey ? { "x-goog-api-key": resolved.apiKey } : {}),
    }),
    parse: parseGoogleList,
    defaultCapabilities: MULTIMODAL_CAPABILITIES,
  },
}
