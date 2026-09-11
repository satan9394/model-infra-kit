import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { HttpError } from "./context.js"
import type { UsageQuery } from "../types.js"
import { redact } from "../util/redact.js"

/** Bodies are whole chat payloads; anything larger is a mistake or an attack. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface CorsOptions {
  /** Allowed origin. Defaults to `*`. */
  origin?: string
  allowHeaders?: string[]
  allowMethods?: string[]
  maxAge?: number
  credentials?: boolean
}

const DEFAULT_CORS_HEADERS = ["authorization", "content-type", "x-modelhub-provider", "accept"]

/** Normalise the `cors` option; `undefined`/`false` means "no CORS headers". */
export function resolveCors(value: boolean | CorsOptions | undefined): CorsOptions | null {
  if (!value) return null
  if (value === true) return { origin: "*" }
  return { ...value, origin: value.origin ?? "*" }
}

export function writeCors(res: ServerResponse, cors: CorsOptions): void {
  res.setHeader("access-control-allow-origin", cors.origin ?? "*")
  res.setHeader("access-control-allow-methods", (cors.allowMethods ?? ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]).join(", "))
  res.setHeader("access-control-allow-headers", (cors.allowHeaders ?? DEFAULT_CORS_HEADERS).join(", "))
  res.setHeader("access-control-max-age", String(cors.maxAge ?? 600))
  if (cors.credentials) res.setHeader("access-control-allow-credentials", "true")
  if ((cors.origin ?? "*") !== "*") res.setHeader("vary", "Origin")
}

/** Path segments, percent-decoded. A malformed escape is a client error. */
export function pathSegments(url: URL): string[] {
  const raw = url.pathname.split("/").filter((segment) => segment.length > 0)
  try {
    return raw.map((segment) => decodeURIComponent(segment))
  } catch {
    throw new HttpError(400, "The request path contains an invalid escape sequence.", "INVALID_REQUEST")
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body ?? null)
  if (res.writableEnded || res.destroyed) return
  // A streamed response already committed its status: all that is left is to end it.
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  })
  res.end(payload)
}

/**
 * The OpenAI error envelope, used by every endpoint in this server:
 * `{ error: { message, type, code } }`. Messages are redacted before leaving.
 */
export function sendError(res: ServerResponse, status: number, message: string, code: string, headers: Record<string, string> = {}): void {
  sendJson(
    res,
    status,
    { error: { message: redact(message), type: status >= 500 ? "server_error" : "invalid_request_error", code } },
    headers,
  )
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "The request body is too large.", "INVALID_REQUEST")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** An empty body is an empty object; anything that is not a JSON object is a 400. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Only true JSON media types: `application/json` and `*+json`, charset
  // allowed. `text/plain` is the one Content-Type a browser can send on a
  // POST without a CORS preflight, so accepting it would open a no-cors write
  // channel for a malicious page — hence 415.
  const mediaType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? ""
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new HttpError(
      415,
      `This endpoint only accepts application/json request bodies (received "${mediaType || "no content-type"}").`,
      "UNSUPPORTED_MEDIA_TYPE",
    )
  }
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.", "INVALID_REQUEST")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "The request body must be a JSON object.", "INVALID_REQUEST")
  }
  return parsed as Record<string, unknown>
}

/**
 * `from` / `to` accept an ISO-8601 string or epoch milliseconds. A bare date
 * (`2026-09-01`) is read as UTC midnight, which is what `Date.parse` does.
 */
function timeParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === "") return undefined
  const value = /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : Date.parse(raw)
  if (!Number.isFinite(value)) {
    throw new HttpError(400, `"${name}" must be an ISO-8601 timestamp or epoch milliseconds.`, "INVALID_REQUEST")
  }
  return value
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === "") return undefined
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new HttpError(400, `"${name}" must be a non-negative integer.`, "INVALID_REQUEST")
  }
  return value
}

/**
 * The query parameters every `/api` collection endpoint shares:
 * `from` / `to` / `provider` / `model` / `status` / `limit` / `offset`.
 *
 * The result is handed to `UsageService`, which scopes it to this instance's
 * `appId`. There is deliberately no `appId` parameter: the HTTP surface must not
 * be a way around the per-app isolation of `UsageService.get()`.
 */
export function parseUsageQuery(url: URL): UsageQuery {
  const query: UsageQuery = {}
  const from = timeParam(url, "from")
  const to = timeParam(url, "to")
  const provider = url.searchParams.get("provider")
  const model = url.searchParams.get("model")
  const status = url.searchParams.get("status")
  const sessionId = url.searchParams.get("sessionId") ?? url.searchParams.get("session")
  const limit = intParam(url, "limit")
  const offset = intParam(url, "offset")

  if (from !== undefined) query.from = from
  if (to !== undefined) query.to = to
  if (provider) query.providerId = provider
  if (model) query.model = model
  if (sessionId) query.sessionId = sessionId
  if (limit !== undefined) query.limit = limit
  if (offset !== undefined) query.offset = offset
  if (status) {
    if (status !== "ok" && status !== "error") {
      throw new HttpError(400, '"status" must be "ok" or "error".', "INVALID_REQUEST")
    }
    query.status = status
  }
  return query
}

/** A constant-time comparison that never reveals the expected length. */
export function safeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) {
    // Still burn a comparison so the timing does not depend on the length.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** The bearer token of a request, or `null` when the header is absent/malformed. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== "string") return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

/** `ModelInfraErrorCode` → HTTP status. An unknown code is a server error. */
export function statusForCode(code: string): number {
  switch (code) {
    case "AUTH":
    case "CREDENTIAL":
      return 401
    case "PROVIDER_NOT_FOUND":
    case "MODEL_NOT_FOUND":
      return 404
    case "RATE_LIMIT":
      return 429
    case "TIMEOUT":
      return 504
    case "CONNECTION":
    case "PROVIDER":
      return 502
    case "INVALID_REQUEST":
      return 400
    default:
      return 500
  }
}
