/**
 * Server-side client for the `mik serve` API.
 *
 * Server-side only: it attaches `MIK_SERVER_TOKEN` and must never be imported
 * from a client component. Client components call the dashboard's own proxy at
 * `/api/mik/*` instead (see `app/api/mik/[...path]/route.ts`).
 */

import { MIK_TIMEOUT_MS, mikServerToken, mikServerUrl } from "./config"

export interface MikCallOptions {
  method?: string
  /** JSON-serialisable body; sent as `application/json`. */
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}

/** A failure the page should render as an error banner, not throw on. */
export class MikUnavailableError extends Error {
  readonly url: string
  readonly status?: number
  readonly code?: string

  constructor(message: string, options: { url: string; status?: number; code?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "MikUnavailableError"
    this.url = options.url
    this.status = options.status
    this.code = options.code
  }
}

function describeTransportError(error: unknown, url: string): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  if (code === "ECONNREFUSED") {
    return `无法连接 mik serve（${url}）：请先运行 \`mik serve\`，或用 MIK_SERVER_URL 指向正确的地址。`
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `无法解析 mik serve 主机（${url}）：检查 MIK_SERVER_URL。`
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `请求 mik serve 超时（${url}）：服务可能未启动或过慢。`
  }
  const message = error instanceof Error ? error.message : String(error)
  return `请求 mik serve 失败（${url}）：${message}`
}

/** One raw call. Throws `MikUnavailableError` for any failure, including a non-2xx. */
export async function mikRaw(path: string, options: MikCallOptions = {}): Promise<Response> {
  const url = `${mikServerUrl()}${path}`
  const headers: Record<string, string> = { accept: "application/json" }
  const token = mikServerToken()
  if (token) headers.authorization = `Bearer ${token}`
  let body: string | undefined
  if (options.body !== undefined) {
    headers["content-type"] = "application/json"
    body = JSON.stringify(options.body)
  }

  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? MIK_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, { method: options.method ?? "GET", headers, body, cache: "no-store", signal })
  } catch (error) {
    throw new MikUnavailableError(describeTransportError(error, url), { url, cause: error })
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => "")
    let message = raw.slice(0, 400) || response.statusText
    let code: string | undefined
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown; code?: unknown } }
      if (typeof parsed.error?.message === "string") message = parsed.error.message
      if (typeof parsed.error?.code === "string") code = parsed.error.code
    } catch {
      // Not the OpenAI error envelope; the raw text is the best available hint.
    }
    throw new MikUnavailableError(`mik serve 返回 ${response.status}：${message}`, {
      url,
      status: response.status,
      code,
    })
  }
  return response
}

/** One call, parsed as JSON. Throws `MikUnavailableError`. */
export async function mikJson<T>(path: string, options: MikCallOptions = {}): Promise<T> {
  const response = await mikRaw(path, options)
  try {
    return (await response.json()) as T
  } catch (error) {
    throw new MikUnavailableError(`mik serve 的响应不是合法 JSON（${response.url || path}）。`, {
      url: response.url || path,
      cause: error,
    })
  }
}

export type MikResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * A call that never throws: pages render an error banner instead of a 500, so
 * an unreachable `mik serve` still shows the shell and the empty states.
 */
export async function mikTry<T>(path: string, options: MikCallOptions = {}): Promise<MikResult<T>> {
  try {
    return { ok: true, data: await mikJson<T>(path, options) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
