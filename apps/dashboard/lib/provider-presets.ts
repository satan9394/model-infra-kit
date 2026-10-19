import { PROVIDER_PRESETS as BUILTIN_PRESETS } from "../../../packages/mik/src/registry/presets.ts"
import { message } from "./i18n/core.ts"
import type { Protocol } from "./types"

export const PROVIDER_PROTOCOLS = [
  "openai-compatible",
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "moonshotai",
  "xai",
] as const satisfies readonly Protocol[]

export const PROVIDER_PRESETS = BUILTIN_PRESETS.map((preset) => {
  const custom = preset.id === "custom-openai-compatible"
  return {
    id: custom ? "custom" : preset.id,
    label: custom ? message("s400") : preset.name,
    providerId: custom ? "" : preset.id,
    name: custom ? "" : preset.name,
    protocol: preset.protocol,
    baseUrl: preset.defaultBaseUrl ?? "",
    apiKeyRef: preset.envKey ? `env:${preset.envKey}` : "",
    // Keyless local presets do not need preset resolution on the server.
    presetId: custom || preset.category === "local" ? undefined : preset.id,
    hint: message(custom ? "s401" : preset.category === "local" ? "s399" : "provider.presetHint"),
    apiKeyUrl: preset.apiKeyUrl,
    recommendedModels: preset.recommendedModels,
  }
})

export type ProviderPresetId = (typeof PROVIDER_PRESETS)[number]["id"]
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number]

export interface ProviderDraft {
  id: string
  name: string
  protocol: string
  baseUrl: string
  apiKeyRef: string
  headersJson: string
  enabled: boolean
  meta?: Record<string, unknown>
  presetId?: string
}

export interface ProviderUpdatePayload {
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKeyRef: string
  headers: Record<string, string>
  enabled: boolean
  meta?: Record<string, unknown>
  presetId?: string
}

export interface ProviderCreatePayload {
  id: string
  name?: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKeyRef?: string
  headers: Record<string, string>
  enabled: boolean
  meta?: Record<string, unknown>
  presetId?: string
}

export type ProviderDraftResult<T> = { ok: true; value: T } | { ok: false; error: string }

export function emptyProviderDraft(): ProviderDraft {
  return {
    id: "",
    name: "",
    protocol: "openai-compatible",
    baseUrl: "",
    apiKeyRef: "",
    headersJson: "{}",
    enabled: true,
  }
}

export function draftFromPreset(presetId: ProviderPresetId): ProviderDraft {
  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId)
  if (!preset) return emptyProviderDraft()

  return {
    id: preset.providerId,
    name: preset.name,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    apiKeyRef: preset.apiKeyRef,
    headersJson: "{}",
    enabled: true,
    ...("presetId" in preset && preset.presetId ? { presetId: preset.presetId } : {}),
  }
}

export function isValidProviderId(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[a-zA-Z0-9_.-]+$/.test(value)
}

function isProviderProtocol(value: string): value is ProviderProtocol {
  return (PROVIDER_PROTOCOLS as readonly string[]).includes(value)
}

/** Empty references are allowed for keyless providers and clearing edits. */
export function isValidApiKeyRef(value: string): boolean {
  const match = /^(env|file|keychain):(.+)$/i.exec(value.trim())
  return !value.trim() || !!match?.[2]?.trim()
}

export function parseProviderHeaders(value: string): ProviderDraftResult<Record<string, string>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value.trim() || "{}")
  } catch {
    return { ok: false, error: message("s402") }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: message("s403") }
  }

  const entries = Object.entries(parsed)
  if (entries.some(([, item]) => typeof item !== "string")) {
    return { ok: false, error: message("s404") }
  }
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> }
}

function readDraft(draft: ProviderDraft): ProviderDraftResult<ProviderUpdatePayload & { id: string }> {
  const id = draft.id.trim()
  if (!isValidProviderId(id)) {
    return { ok: false, error: message("s405") }
  }
  if (!isProviderProtocol(draft.protocol)) {
    return { ok: false, error: message("s406") }
  }
  if (!isValidApiKeyRef(draft.apiKeyRef)) return { ok: false, error: "provider.probeCredential" }
  const headers = parseProviderHeaders(draft.headersJson)
  if (!headers.ok) return headers

  return {
    ok: true,
    value: {
      id,
      name: draft.name.trim(),
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim(),
      apiKeyRef: draft.apiKeyRef.trim(),
      headers: headers.value,
      enabled: draft.enabled,
      ...(draft.meta ? { meta: draft.meta } : {}),
      ...(draft.presetId?.trim() ? { presetId: draft.presetId.trim() } : {}),
    },
  }
}

export function buildCreateProviderPayload(draft: ProviderDraft): ProviderDraftResult<ProviderCreatePayload> {
  const parsed = readDraft(draft)
  if (!parsed.ok) return parsed
  const { id, ...fields } = parsed.value
  return {
    ok: true,
    value: {
      id,
      protocol: fields.protocol,
      headers: fields.headers,
      enabled: fields.enabled,
      ...(fields.meta ? { meta: fields.meta } : {}),
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.baseUrl ? { baseUrl: fields.baseUrl } : {}),
      ...(fields.apiKeyRef ? { apiKeyRef: fields.apiKeyRef } : {}),
      ...(fields.presetId ? { presetId: fields.presetId } : {}),
    },
  }
}

export function buildProviderUpdatePayload(draft: ProviderDraft): ProviderDraftResult<ProviderUpdatePayload> {
  const parsed = readDraft(draft)
  if (!parsed.ok) return parsed
  const { id: _id, ...payload } = parsed.value
  return { ok: true, value: payload }
}
