import type { IncomingMessage } from "node:http"
import { HttpError, type ServerContext } from "./context.js"
import { bearerToken, safeEqual } from "./http.js"

export type GatewayScope = "*" | "admin" | "write:chat" | "write:usage" | "read:usage"
export interface GatewayToken {
  token: string
  scopes: GatewayScope[]
  appId?: string
}
/** Config files contain references, never the token itself. */
export interface TokenReference {
  tokenRef: string
  scopes: GatewayScope[]
  appId?: string
}

const SCOPES: readonly string[] = ["*", "admin", "write:chat", "write:usage", "read:usage"]

export function validateTokens(input: unknown): GatewayToken[] {
  if (!Array.isArray(input)) throw new HttpError(400, "Invalid gateway token configuration.")
  const seen = new Set<string>()
  return input.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "Invalid gateway token configuration.")
    const value = item as Record<string, unknown>
    if (typeof value.token !== "string" || !value.token.trim() || value.token !== value.token.trim()
      || !Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string" && SCOPES.includes(scope))
      || (value.appId !== undefined && (typeof value.appId !== "string" || !value.appId.trim() || value.appId !== value.appId.trim()))
      || seen.has(value.token)) throw new HttpError(400, "Invalid gateway token configuration.")
    seen.add(value.token)
    return { token: value.token, scopes: [...value.scopes] as GatewayScope[], appId: value.appId as string | undefined }
  })
}

/** Environment mapping is a JSON array; injected env keeps CLI tests deterministic. */
export function resolveTokens(references: unknown, env: NodeJS.ProcessEnv): GatewayToken[] {
  if (env.MIK_SERVER_TOKENS !== undefined) {
    try { return validateTokens(JSON.parse(env.MIK_SERVER_TOKENS)) }
    catch { throw new HttpError(400, "Invalid MIK_SERVER_TOKENS configuration.") }
  }
  if (references === undefined) return []
  if (!Array.isArray(references)) throw new HttpError(400, "Invalid gateway token references.")
  return validateTokens(references.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "Invalid gateway token reference.")
    const value = item as Record<string, unknown>
    if (typeof value.tokenRef !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value.tokenRef)) {
      throw new HttpError(400, "Gateway tokens require an env reference.")
    }
    return { token: env[value.tokenRef.slice(4)], scopes: value.scopes, appId: value.appId }
  }))
}

export function authenticate(req: IncomingMessage, tokens: GatewayToken[]): GatewayToken | undefined {
  const presented = bearerToken(req)
  return tokens.find((entry) => presented !== null && safeEqual(presented, entry.token))
}

export function requireScope(scope: string): (ctx: Pick<ServerContext, "auth">) => void {
  return (ctx) => {
    const scopes = ctx.auth?.scopes ?? []
    if (!scopes.includes("*") && !scopes.includes("admin") && !scopes.some((entry) => entry === scope)) {
      throw new HttpError(403, "insufficient_scope", "FORBIDDEN")
    }
  }
}

/** Unknown endpoints default to admin, including provider credentials and probes. */
export function endpointScope(method: string, segments: string[]): GatewayScope {
  const path = segments.join("/")
  if (method === "POST" && path === "v1/chat/completions") return "write:chat"
  if (method === "POST" && path === "api/usage/events") return "write:usage"
  if (method === "GET" && (path.startsWith("api/usage/") || ["api/events", "api/pricing", "api/catalog", "api/models", "api/budget/status", "v1/models", "openapi.json"].includes(path)
    || path === "metrics" || path.startsWith("api/models/"))) return "read:usage"
  return "admin"
}
