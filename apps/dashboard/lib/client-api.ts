"use client"

/**
 * Browser-side calls to the dashboard's own proxy.
 *
 * Never talks to `mik serve` directly: the proxy keeps `MIK_SERVER_URL` and the
 * bearer token server-side, and the mik server itself ships CORS disabled.
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

export async function apiCall<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" }
  let body: string | undefined
  if (init.body !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(init.body)
  }

  try {
    const response = await fetch(`/api/mik${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
      cache: "no-store",
    })
    const text = await response.text()
    if (!response.ok) {
      let message = text.slice(0, 300) || response.statusText
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } }
        if (typeof parsed.error?.message === "string") message = parsed.error.message
      } catch {
        // Keep the raw text.
      }
      return { ok: false, error: `HTTP ${response.status}：${message}` }
    }
    return { ok: true, data: (text ? JSON.parse(text) : null) as T }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
