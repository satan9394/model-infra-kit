import { autoBypass } from "./auto-context.js"

const targets: Record<string, string> = { "api.openai.com": "openai", "api.anthropic.com": "anthropic", "api.deepseek.com": "deepseek" }
const variables = { OPENAI_BASE_URL: "/__mik_auto/openai/v1", ANTHROPIC_BASE_URL: "/__mik_auto/anthropic", DEEPSEEK_BASE_URL: "/__mik_auto/deepseek/v1" }
let undo: (() => void) | undefined

/** Restore only values still owned by this adapter; later host changes win. */
export function restore(): void {
  undo?.()
  undo = undefined
}

/** Bounded loopback discovery. An unrelated listener is never adopted. */
export async function install(): Promise<boolean> {
  if (undo) return true
  const original = globalThis.fetch
  let gateway: URL
  try {
    gateway = new URL(process.env.MIK_GATEWAY_URL ?? "http://127.0.0.1:3211")
    if (gateway.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname)
      || gateway.username || gateway.password || gateway.search || gateway.hash
      || !["/", "/v1", "/v1/"].includes(gateway.pathname)) return false
    gateway = new URL(gateway.origin)
    const response = await original(new URL("/api/health", gateway), { signal: AbortSignal.timeout(750), redirect: "error" })
    if (!response.ok) return false
    const health = await response.json() as Record<string, unknown>
    if (health.service !== "model-infra-kit" || health.status !== "ok" || typeof health.appId !== "string") return false
  } catch { return false }

  // Another importer may have installed while discovery was awaiting IO.
  if (undo) return true
  if (globalThis.fetch !== original) return false
  const token = process.env.MIK_GATEWAY_TOKEN
  const previous = new Map<string, string | undefined>()
  const injected = new Map<string, string>()
  for (const [key, path] of Object.entries(variables)) {
    previous.set(key, process.env[key])
    const value = `${gateway.origin}${path}`
    process.env[key] = value
    injected.set(key, value)
  }
  const wrapped: typeof fetch = async (input, init) => {
    if (autoBypass.getStore()) return original(input, init)
    let url: URL
    try { url = new URL(input instanceof Request ? input.url : String(input)) }
    catch { return original(input, init) }
    const target = url.protocol === "https:" && !url.port && !url.username && !url.password && Object.hasOwn(targets, url.hostname)
    // SDKs consume BASE_URL before fetch. Only our dedicated SDK namespaces
    // belong to this adapter; ordinary calls to the same gateway pass through.
    const local = url.origin === gateway.origin && !url.username && !url.password
      ? /^\/__mik_auto\/(openai|anthropic|deepseek)(?=\/|$)/.exec(url.pathname) : null
    if (!target && !local) return original(input, init)
    const request = new Request(input, init)
    const protocol = target ? targets[url.hostname]! : local![1]!
    if (target) {
      url = new URL(`${url.pathname}${url.search}`, gateway)
      if (!url.pathname.startsWith("/v1/")) url.pathname = `/v1${url.pathname}`
    } else {
      url.pathname = url.pathname.slice(local![0].length)
      if (!url.pathname.startsWith("/v1/")) url.pathname = `/v1${url.pathname}`
    }
    const headers = new Headers(request.headers)
    if (init?.body instanceof FormData && !new Headers(init.headers).has("content-type")) headers.delete("content-type")
    headers.set("x-mik-auto-protocol", protocol)
    if (token) {
      for (const key of ["authorization", "x-api-key", "api-key", "x-goog-api-key"]) headers.delete(key)
      headers.set("authorization", `Bearer ${token}`)
    }
    // Retain a supplied body source (string/Blob/FormData) so native fetch can
    // replay it for HTTP authentication challenges. Request inputs retain
    // their native stream semantics, including caller body consumption.
    const forwarded = new Request(url, { method: request.method,
      headers, body: init?.body ?? request.body, signal: request.signal,
      cache: request.cache, credentials: request.credentials, integrity: request.integrity,
      keepalive: request.keepalive, mode: request.mode, redirect: request.redirect,
      referrer: request.referrer, referrerPolicy: request.referrerPolicy,
      ...(request.body ? { duplex: "half" } : {}),
    })
    const { body: _body, headers: _headers, ...transportOptions } = init ?? {}
    return original(forwarded, transportOptions)
  }
  globalThis.fetch = wrapped
  undo = () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original
    for (const [key, value] of injected) {
      if (process.env[key] !== value) continue
      const before = previous.get(key)
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    }
  }
  return true
}

// ESM evaluation waits for discovery before the host constructs a default SDK.
await install()
