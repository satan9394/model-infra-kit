import { apiCall, type ApiResult } from "./client-api.ts"
import type { ProviderCreatePayload } from "./provider-presets"

/** A default-model failure must never turn a successful creation into a retry. */
export async function createProvider(payload: ProviderCreatePayload, defaultModelId?: string): Promise<ApiResult<{ defaultError: string | null }>> {
  const created = await apiCall("/providers", { method: "POST", body: payload })
  if (!created.ok) return created
  if (!defaultModelId && !Array.isArray(payload.meta?.models)) return { ok: true, data: { defaultError: null } }
  return syncProviderModels(payload.id, defaultModelId)
}

export async function syncProviderModels(id: string, defaultModelId?: string): Promise<ApiResult<{ defaultError: string | null }>> {
  const refreshed = await apiCall(`/providers/${encodeURIComponent(id)}/models/refresh`, { method: "POST" })
  if (!refreshed.ok) return { ok: true, data: { defaultError: refreshed.error } }
  if (!defaultModelId) return { ok: true, data: { defaultError: null } }
  const selected = await apiCall(`/models/${encodeURIComponent(`${id}:${defaultModelId}`)}/default`, { method: "PUT" })
  return { ok: true, data: { defaultError: selected.ok ? null : selected.error } }
}
