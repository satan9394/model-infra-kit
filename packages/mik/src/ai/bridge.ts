import { createProviderRegistry, type LanguageModel, type ProviderRegistryProvider } from "ai"
import { ModelInfraError, toModelInfraError } from "../errors.js"
import { MODEL_REF_SEPARATOR, type ProviderRegistry, type ResolvedProvider } from "../registry/registry.js"
import type { ModelCapabilities, ModelInfo, ProviderStatus } from "../types.js"
import { redact } from "../util/redact.js"
import { MODEL_LIST_PROTOCOLS, SDK_PROTOCOLS, loadProviderFactory, type DiscoveredModel } from "./protocols.js"

export interface AiBridgeDeps {
  registry: ProviderRegistry
  onWarn?: (message: string, error?: unknown) => void
}

export interface AiBridge {
  /** 解析成 AI SDK 的 LanguageModel，协议由 provider.protocol 数据映射决定 */
  languageModel(providerId: string, modelId: string): Promise<LanguageModel>
  /** 连接测试：一次最小调用或模型列表探测 */
  test(providerId: string): Promise<ProviderStatus>
  /** 模型发现，成功时返回 provider_api 来源的 ModelInfo[] */
  discoverModels(providerId: string): Promise<ModelInfo[]>
}

/** A provider instance as accepted by the AI SDK's own registry. */
type SdkProvider = Parameters<typeof createProviderRegistry>[0][string]

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_DETAIL_CHARS = 240

function timeoutMsFor(resolved: ResolvedProvider): number {
  const fromMeta = resolved.record.meta?.timeoutMs
  if (typeof fromMeta === "number" && Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta
  const fromEnv = Number(process.env.MIK_PROVIDER_TIMEOUT_MS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return DEFAULT_TIMEOUT_MS
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** An error carrying the HTTP status so `toModelInfraError` can classify it. */
function httpFailure(status: number, body: string): Error {
  const detail = redact(body.replace(/\s+/g, " ").trim())
  const error = new Error(detail || `HTTP ${status}`) as Error & { status: number; response: { status: number } }
  error.status = status
  error.response = { status }
  return error
}

/**
 * A human-readable failure line.
 *
 * Auth failures deliberately drop the upstream body: it routinely echoes the
 * rejected key, and `ProviderStatus.message` is surfaced to end users. A
 * provider that needs no key at all must not be told its key was rejected.
 */
function failureMessage(mapped: ModelInfraError, cause: unknown, keyless = false): string {
  const status = typeof mapped.status === "number" ? ` (HTTP ${mapped.status})` : ""
  const isAuth = mapped.code === "AUTH" || mapped.status === 401 || mapped.status === 403
  const detail = !isAuth && cause instanceof Error ? redact(cause.message).replace(/\s+/g, " ").trim() : ""
  const suffix = detail && detail !== mapped.message ? ` ${truncate(detail, MAX_DETAIL_CHARS)}` : ""
  const base =
    keyless && isAuth
      ? "The provider rejected the request, and this provider is configured without an API key."
      : redact(mapped.message)
  return `${base}${status}${suffix}`
}

function toModelInfo(providerId: string, discovered: DiscoveredModel, fallback: ModelCapabilities): ModelInfo {
  const capabilities: ModelCapabilities = { ...fallback, ...discovered.capabilities }
  return {
    providerId,
    modelId: discovered.modelId,
    ref: `${providerId}${MODEL_REF_SEPARATOR}${discovered.modelId}`,
    displayName: discovered.displayName ?? discovered.modelId,
    contextWindow: discovered.contextWindow,
    maxOutputTokens: discovered.maxOutputTokens,
    capabilities,
    source: "provider_api",
    syncedAt: Date.now(),
  }
}

/** Cheap non-reversible digest, only used to notice that a secret changed. */
function digest(secret: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < secret.length; index += 1) {
    hash ^= secret.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

function fingerprintOf(resolved: ResolvedProvider): string {
  const { record } = resolved
  return [
    record.protocol,
    record.baseUrl ?? "",
    record.npmPackage ?? "",
    record.apiKeyRef ?? "",
    resolved.apiKey ? digest(resolved.apiKey) : "none",
    JSON.stringify(record.headers),
  ].join("|")
}

export function createAiBridge(deps: AiBridgeDeps): AiBridge {
  const { registry } = deps
  const cache = new Map<string, { fingerprint: string; provider: ProviderRegistryProvider }>()

  /** Fetch the provider's model list over HTTP, bounded by the provider timeout. */
  async function fetchModelList(resolved: ResolvedProvider): Promise<DiscoveredModel[]> {
    const adapter = MODEL_LIST_PROTOCOLS[resolved.protocol]
    if (!adapter) {
      throw new ModelInfraError(`Unsupported protocol "${String(resolved.protocol)}".`, {
        code: "PROVIDER",
        providerId: resolved.record.id,
      })
    }
    const response = await fetch(adapter.url(resolved), {
      method: "GET",
      headers: adapter.headers(resolved),
      signal: AbortSignal.timeout(timeoutMsFor(resolved)),
    })
    const body = await response.text()
    if (!response.ok) throw httpFailure(response.status, body)
    try {
      return adapter.parse(JSON.parse(body) as unknown)
    } catch (error) {
      throw new ModelInfraError(
        `Provider "${resolved.record.id}" returned a model list that could not be parsed.`,
        { code: "PROVIDER", status: response.status, providerId: resolved.record.id, cause: error },
      )
    }
  }

  /** Build (and cache) an AI SDK registry for one provider. */
  async function sdkRegistryFor(resolved: ResolvedProvider): Promise<ProviderRegistryProvider> {
    const fingerprint = fingerprintOf(resolved)
    const cached = cache.get(resolved.record.id)
    if (cached && cached.fingerprint === fingerprint) return cached.provider

    const factory = await loadProviderFactory(resolved.protocol)
    const options = SDK_PROTOCOLS[resolved.protocol].factoryOptions(resolved)
    let instance: SdkProvider
    try {
      instance = factory(options) as SdkProvider
    } catch (error) {
      throw toModelInfraError(error, { providerId: resolved.record.id })
    }
    const provider = createProviderRegistry({ [resolved.record.id]: instance }, { separator: MODEL_REF_SEPARATOR })
    cache.set(resolved.record.id, { fingerprint, provider })
    return provider
  }

  return {
    async languageModel(providerId: string, modelId: string): Promise<LanguageModel> {
      const resolved = registry.resolve(providerId)
      const provider = await sdkRegistryFor(resolved)
      return provider.languageModel(`${resolved.record.id}${MODEL_REF_SEPARATOR}${modelId}`)
    },

    async test(providerId: string): Promise<ProviderStatus> {
      const startedAt = Date.now()
      let resolved: ResolvedProvider | undefined
      try {
        resolved = registry.resolve(providerId)
        const models = await fetchModelList(resolved)
        return {
          providerId,
          ok: true,
          message: `Connected. The provider reports ${models.length} model${models.length === 1 ? "" : "s"}.`,
          modelCount: models.length,
          latencyMs: Date.now() - startedAt,
          checkedAt: startedAt,
        }
      } catch (error) {
        const mapped = toModelInfraError(error, { providerId })
        const message = failureMessage(mapped, error, resolved?.apiKeySource === "none")
        deps.onWarn?.(`Provider check failed for "${providerId}": ${message}`, error)
        return {
          providerId,
          ok: false,
          message,
          latencyMs: Date.now() - startedAt,
          checkedAt: startedAt,
        }
      }
    },

    async discoverModels(providerId: string): Promise<ModelInfo[]> {
      try {
        const resolved = registry.resolve(providerId)
        const adapter = MODEL_LIST_PROTOCOLS[resolved.protocol]
        const discovered = await fetchModelList(resolved)
        return discovered.map((model) => toModelInfo(providerId, model, adapter.defaultCapabilities))
      } catch (error) {
        const mapped = toModelInfraError(error, { providerId })
        deps.onWarn?.(`Could not discover models for provider "${providerId}": ${failureMessage(mapped, error)}`, error)
        return []
      }
    },
  }
}
