import type { Protocol } from "./types"

export const PROVIDER_PROTOCOLS = [
  "openai-compatible",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "moonshotai",
  "xai",
] as const satisfies readonly Protocol[]

export const PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    providerId: "deepseek",
    name: "DeepSeek",
    protocol: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyRef: "env:DEEPSEEK_API_KEY",
    presetId: "deepseek",
    hint: "深度求索",
  },
  {
    id: "openai",
    label: "OpenAI",
    providerId: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRef: "env:OPENAI_API_KEY",
    presetId: "openai",
    hint: "GPT 系列",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    providerId: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyRef: "env:ANTHROPIC_API_KEY",
    presetId: "anthropic",
    hint: "Claude 系列",
  },
  {
    id: "google",
    label: "Google Gemini",
    providerId: "google",
    name: "Google Gemini",
    protocol: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyRef: "env:GOOGLE_GENERATIVE_AI_API_KEY",
    presetId: "google",
    hint: "Gemini 系列",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    providerId: "openrouter",
    name: "OpenRouter",
    protocol: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyRef: "env:OPENROUTER_API_KEY",
    presetId: "openrouter",
    hint: "多模型路由",
  },
  {
    id: "ollama",
    label: "Ollama (本地)",
    providerId: "ollama",
    name: "Ollama (Local)",
    protocol: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    apiKeyRef: "",
    hint: "本地运行",
  },
  {
    id: "custom",
    label: "自定义",
    providerId: "",
    name: "",
    protocol: "openai-compatible",
    baseUrl: "",
    apiKeyRef: "",
    hint: "手动配置",
  },
] as const

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
  presetId?: string
}

export interface ProviderUpdatePayload {
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKeyRef: string
  headers: Record<string, string>
  enabled: boolean
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

export function parseProviderHeaders(value: string): ProviderDraftResult<Record<string, string>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value.trim() || "{}")
  } catch {
    return { ok: false, error: "Headers 必须是有效的 JSON 对象。" }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Headers 必须是键和值均为字符串的 JSON 对象。" }
  }

  const entries = Object.entries(parsed)
  if (entries.some(([, item]) => typeof item !== "string")) {
    return { ok: false, error: "Headers 的每个值都必须是字符串。" }
  }
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> }
}

function readDraft(draft: ProviderDraft): ProviderDraftResult<ProviderUpdatePayload & { id: string }> {
  const id = draft.id.trim()
  if (!isValidProviderId(id)) {
    return { ok: false, error: "ID 需为 1–64 位字母、数字、点、下划线或短横线，且不能包含冒号。" }
  }
  if (!isProviderProtocol(draft.protocol)) {
    return { ok: false, error: "请选择有效的供应商协议。" }
  }
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
