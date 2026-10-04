import { once } from "node:events"
import { HttpError, type ServerContext } from "./context.js"
import { readJsonBody } from "./http.js"
import { redact, redactDeep } from "../util/redact.js"
import type { Protocol } from "../types.js"

const compatible: Record<string, readonly Protocol[]> = {
  openai: ["openai", "openai-compatible", "deepseek", "moonshotai", "xai"],
  deepseek: ["deepseek", "openai-compatible"],
  anthropic: ["anthropic"],
}
const completionProtocols = new Set(["openai", "deepseek"])

export async function handleNativeCompletion(ctx: ServerContext, endpoint = "chat/completions"): Promise<void> {
  const protocol = ctx.req.headers["x-mik-auto-protocol"] ?? "openai"
  if (typeof protocol !== "string" || !completionProtocols.has(protocol)) throw new HttpError(400, "Unsupported client protocol.", "INVALID_REQUEST")
  return forwardNative(ctx, protocol, endpoint)
}

/** Native Anthropic wire format, using the same forwarding/metering adapter. */
export async function handleMessages(ctx: ServerContext): Promise<void> {
  return forwardNative(ctx, "anthropic", "messages")
}

async function forwardNative(ctx: ServerContext, protocol: string, endpoint: string): Promise<void> {
  const payload = await readJsonBody(ctx.req)
  if (typeof payload.model !== "string" || !payload.model.trim()) throw new HttpError(400, "model is required.", "INVALID_REQUEST")
  const protocols = compatible[protocol]!
  let target: ReturnType<typeof ctx.hub.resolveModel> | undefined
  try { target = ctx.hub.resolveModel(payload.model) } catch (error) { if (payload.model.includes(":")) throw error }
  if ((!target || !protocols.includes(ctx.hub.providers.get(target.providerId)!.protocol ?? "openai-compatible")) && !payload.model.includes(":")) {
    const candidates = ctx.hub.providers.list().filter(provider => provider.enabled && protocols.includes(provider.protocol ?? "openai-compatible"))
    if (candidates.length === 1) target = ctx.hub.resolveModel(`${candidates[0]!.id}:${payload.model}`)
  }
  if (!target || !protocols.includes(ctx.hub.providers.get(target.providerId)!.protocol ?? "openai-compatible")) throw new HttpError(400, "No unambiguous provider for the client protocol. Use provider:model.", "INVALID_REQUEST")
  ctx.updateConnectionModel?.(target.modelId)
  const controller = new AbortController()
  const abort = () => { if (!ctx.res.writableFinished) controller.abort() }
  ctx.res.once("close", abort)
  ctx.req.once("aborted", abort)
  try {
    const headers = new Headers()
    for (const [key, value] of Object.entries(ctx.req.headers)) if (value !== undefined && key !== "x-mik-auto-protocol") headers.set(key, Array.isArray(value) ? value.join(", ") : value)
    const response = await ctx.hub.fetch(`${ctx.origin}/v1/${endpoint}${ctx.url.search}`, {
      method: "POST", headers, body: JSON.stringify({ ...payload, model: `${target.providerId}:${target.modelId}` }), signal: controller.signal,
    })
    const outgoing: Record<string, string> = {}
    response.headers.forEach((value, key) => { if (!["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie"].includes(key)) outgoing[key] = redact(value) })
    ctx.res.writeHead(response.status, redactDeep(outgoing))
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const raw = await response.text()
      try { ctx.res.end(JSON.stringify(redactDeep(JSON.parse(raw)))) }
      catch { ctx.res.end(redact(raw)) }
      return
    }
    if (response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ""
      try {
        while (!ctx.res.destroyed) {
          const chunk = await reader.read()
          pending += decoder.decode(chunk.value, { stream: !chunk.done })
          let end = pending.indexOf("\n")
          while (end >= 0) {
            const line = pending.slice(0, end)
            pending = pending.slice(end + 1)
            let safe = redact(line)
            if (line.startsWith("data:")) {
              try { safe = `data: ${JSON.stringify(redactDeep(JSON.parse(line.slice(5))))}` } catch { /* non-JSON SSE comment */ }
            }
            if (!ctx.res.write(`${safe}\n`)) await once(ctx.res, "drain", { signal: controller.signal })
            end = pending.indexOf("\n")
          }
          if (chunk.done) { if (pending) ctx.res.write(redact(pending)); break }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    ctx.res.end()
  } finally {
    ctx.res.off("close", abort)
    ctx.req.off("aborted", abort)
  }
}
