import { apiCall, type ApiResult } from "./client-api.ts"
import type { ProviderCreatePayload } from "./provider-presets"

/** A default-model failure must never turn a successful creation into a retry. */
export async function createProvider(payload: ProviderCreatePayload, defaultModelId?: string): Promise<ApiResult<{ defaultError: string | null }>> {
  const created = await apiCall("/providers", { method: "POST", body: payload })
  if (!created.ok) return created
  if (!defaultModelId) return { ok: true, data: { defaultError: null } }
  const refreshed = await apiCall(`/providers/${encodeURIComponent(payload.id)}/models/refresh`, { method: "POST" })
  if (!refreshed.ok) return { ok: true, data: { defaultError: refreshed.error } }
  const selected = await apiCall(`/models/${encodeURIComponent(`${payload.id}:${defaultModelId}`)}/default`, { method: "PUT" })
  return { ok: true, data: { defaultError: selected.ok ? null : selected.error } }
}
