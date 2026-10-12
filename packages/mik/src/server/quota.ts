import { randomUUID } from "node:crypto"
import { QuotaHierarchy } from "../quota/hierarchy.js"
import { redact, redactDeep } from "../util/redact.js"
import { HttpError, type ServerContext } from "./context.js"
import { readJsonBody, sendError } from "./http.js"

/** Conservative text-only reservation. Bytes bound text tokens without a
 * tokenizer dependency; explicit output ceiling is required for hard TPM.
 * Never trust a client-supplied token-count header.
 */
export function reserveTokens(body: Record<string, unknown>, endpoint = "chat/completions"): number {
  const limits = (endpoint === "responses" ? [body.max_output_tokens]
    : endpoint === "messages" ? [body.max_tokens] : [body.max_tokens ?? body.max_completion_tokens]).filter(value => value !== undefined)
  if (!limits.length || limits.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) throw new HttpError(400, "TPM quotas require a positive output token limit.", "INVALID_REQUEST")
  const maximum = Math.max(...limits as number[])
  if (body.n !== undefined && body.n !== 1) throw new HttpError(400, "TPM quotas support one completion per request.", "INVALID_REQUEST")
  if (body.previous_response_id !== undefined || body.conversation !== undefined
    || body.prompt !== undefined && typeof body.prompt !== "string"
    || body.tools !== undefined || body.functions !== undefined) {
    throw new HttpError(400, "TPM quotas require locally serialized text context without provider tools.", "INVALID_REQUEST")
  }
  const text = JSON.stringify(body)
  // Images/audio/files have token costs unrelated to their URL or byte length.
  if (/"type"\s*:\s*"(?:image[^"\\]*|input_image|audio[^"\\]*|input_audio|file|input_file|document|video[^"\\]*)"/.test(text)
    || /"type"\s*:\s*"item_reference"/.test(text)
    || body.modalities !== undefined || body.audio !== undefined) {
    throw new HttpError(400, "TPM quota reservations support text requests only.", "INVALID_REQUEST")
  }
  const tokens = Buffer.byteLength(text, "utf8") + maximum
  if (!Number.isSafeInteger(tokens)) throw new HttpError(400, "Invalid token reservation.", "INVALID_REQUEST")
  return tokens
}

export async function guardQuota(ctx: ServerContext, quotas: QuotaHierarchy): Promise<boolean> {
  // Parse once using the standard bounded JSON parser, reused by both handlers.
  const body = await readJsonBody(ctx.req)
  const appId = ctx.appId!
  if (!quotas.hasApp(appId)) throw new HttpError(403, "Application has no configured quota.", "FORBIDDEN")
  const endpoint = ctx.url.pathname.split("/").slice(-1)[0]!
  const result = quotas.check(appId, quotas.hasTokenLimit(appId) ? reserveTokens(body, endpoint) : 1)
  if (result.allowed) return true
  const retry = result.retryAfterSeconds!
  const reason = result.reason!
  ctx.hub.usage.withAppScope(appId, () => ctx.hub.usage.record({
    requestId: randomUUID(), ts: Date.now(), source: "quota", providerId: "local",
    modelRequested: "quota", modelActual: "quota", status: "RATE_LIMITED", errorCode: redact(reason),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: { usd: 0, low: 0, high: 0, basis: "exact", source: "manual" }, isStreaming: body.stream === true,
    tags: redactDeep({ quota_reason: reason }),
  }))
  sendError(ctx.res, 429, redact("Tenant quota limit reached."), reason, {
    "Retry-After": String(retry), "X-Mik-RateLimit-Remaining-Requests": String(Math.max(0, (result.limitRpm ?? result.currentRpm) - result.currentRpm)),
    "X-Mik-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + retry),
  })
  return false
}
