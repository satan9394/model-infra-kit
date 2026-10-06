import { MODEL_LIST_PROTOCOLS, type DiscoveredModel } from "../ai/protocols.js"
import { ModelInfraError, toModelInfraError } from "../errors.js"
import { getPreset, PROTOCOL_PACKAGES } from "../registry/presets.js"
import type { ResolvedProvider } from "../registry/registry.js"
import type { Protocol, ProviderStatus } from "../types.js"
import { redact, redactDeep } from "../util/redact.js"
import { HttpError } from "./context.js"
import { assertSafeOutboundUrl } from "./outbound.js"

export interface ProviderProbeInput {
  baseUrl?: string
  apiKeyRef?: string
  protocol: Protocol
}

export interface ProviderProbeResult {
  status: ProviderStatus & { errorCode?: string }
  models: DiscoveredModel[]
  baseUrl?: string
}

const PROBE_OPTIONS: Partial<Record<Protocol, { stripChatCompletions?: boolean; rootPaths?: string[]; listField?: string }>> = {
  openai: { stripChatCompletions: true, rootPaths: ["/v1/models", "/models"] },
  "openai-compatible": { stripChatCompletions: true, rootPaths: ["/v1/models", "/models"] },
  anthropic: { rootPaths: ["/v1/models"] },
  google: { listField: "models" },
}

/** Candidate model endpoints; the successful parent URL can be saved unchanged. */
export function probeModelUrls(baseUrl: string, protocol: Protocol): string[] {
  const url = new URL(baseUrl)
  if (url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, "Provider baseUrl must not contain credentials, query parameters or fragments.", "INVALID_REQUEST")
  }
  let path = url.pathname.replace(/\/+$/, "")
  if (path.endsWith("/models")) { url.pathname = path; return [url.href] }
  const options = PROBE_OPTIONS[protocol]
  if (options?.stripChatCompletions) path = path.replace(/\/chat\/completions$/, "")
  const paths = !path && options?.rootPaths ? options.rootPaths : [`${path}/models`]
  return paths.map(pathname => { const target = new URL(url); target.pathname = pathname; return target.href })
}

/** Read-only, one-shot discovery: no registry, catalogue, credential or usage writes. */
export async function probeProvider(input: ProviderProbeInput, resolveCredential: (ref: string) => string): Promise<ProviderProbeResult> {
  if (input.apiKeyRef?.trim() && !/^(env|file|keychain):.+$/i.test(input.apiKeyRef.trim())) {
    throw new HttpError(400, "apiKeyRef must use env:, file: or keychain: references.", "INVALID_REQUEST")
  }
  const baseUrl = input.baseUrl?.trim() || getPreset(input.protocol)?.defaultBaseUrl
  if (!baseUrl) throw new HttpError(400, '"baseUrl" is required for this protocol.', "INVALID_REQUEST")
  assertSafeOutboundUrl(baseUrl, "provider baseUrl")
  const urls = probeModelUrls(baseUrl, input.protocol)
  for (const url of urls) assertSafeOutboundUrl(url, "provider model endpoint")
  const checkedAt = Date.now()
  let apiKey: string | null = null
  const safe = (text: string) => redact(apiKey ? text.split(apiKey).join("[REDACTED]") : text)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ModelInfraError("Provider probe timed out after 5 seconds.", { code: "TIMEOUT" }))
    }, 5000)
  })
  try {
    const result = await Promise.race([deadline, (async () => {
      if (input.apiKeyRef?.trim()) apiKey = resolveCredential(input.apiKeyRef.trim())
      const record = { id: "probe", appId: "probe", name: "probe", protocol: input.protocol,
        headers: {}, meta: {}, enabled: true, createdAt: checkedAt, updatedAt: checkedAt }
      const resolved: ResolvedProvider = { record, protocol: input.protocol, baseUrl, apiKey,
        apiKeySource: apiKey ? "ref" : "none", npmPackage: PROTOCOL_PACKAGES[input.protocol] }
      const adapter = MODEL_LIST_PROTOCOLS[input.protocol]
      for (const [index, url] of urls.entries()) {
        if (controller.signal.aborted) throw new ModelInfraError("Provider probe timed out.", { code: "TIMEOUT" })
        const response = await fetch(url, { headers: adapter.headers(resolved), signal: controller.signal, redirect: "error" })
        const text = await response.text()
        // Only an absent endpoint warrants the root-path fallback; auth/network failures do not.
        if (response.status === 404 && index + 1 < urls.length) continue
        if (!response.ok) throw new ModelInfraError(safe(text).slice(0, 240) || `HTTP ${response.status}`, {
          code: response.status === 401 || response.status === 403 ? "AUTH" : response.status === 429 ? "RATE_LIMIT" : "PROVIDER",
          status: response.status,
        })
        let payload: unknown
        try { payload = JSON.parse(text) } catch { throw new ModelInfraError("The provider returned invalid model-list JSON.", { code: "PROVIDER" }) }
        const field = PROBE_OPTIONS[input.protocol]?.listField ?? "data"
        if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>)[field])) {
          throw new ModelInfraError("The provider returned an invalid model list.", { code: "PROVIDER" })
        }
        // Replace the actual resolved key in parsed model fields, even for nonstandard key formats.
        const models = redactDeep(adapter.parse(payload)).map(model => ({ ...model,
          modelId: safe(model.modelId), displayName: model.displayName === undefined ? undefined : safe(model.displayName) }))
        return { models, baseUrl: safe(url.replace(/\/models$/, "")) }
      }
      throw new ModelInfraError("No model endpoint was found.", { code: "PROVIDER" })
    })()])
    if (Date.now() - checkedAt >= 5000) throw new ModelInfraError("Provider probe timed out after 5 seconds.", { code: "TIMEOUT" })
    return { ...result, status: { providerId: "probe", ok: true, modelCount: result.models.length,
      latencyMs: Date.now() - checkedAt, checkedAt, message: "Connected." } }
  } catch (error) {
    const mapped = toModelInfraError(error)
    return { models: [], status: { providerId: "probe", ok: false, modelCount: 0, checkedAt,
      latencyMs: Date.now() - checkedAt, errorCode: mapped.code,
      message: safe(mapped.message) } }
  } finally {
    clearTimeout(timer)
  }
}
