import type { IncomingMessage } from "node:http"
import type { SpanEventMetadata } from "../types.js"
import { redact } from "../util/redact.js"
import { HttpError } from "./context.js"

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? redact(value.trim()).slice(0, 128) : undefined

export function readSpanHeaders(req: IncomingMessage, body: Record<string, unknown> = {}): SpanEventMetadata {
  const read = (key: string, header: string): unknown => req.headers[header] ?? body[key]
  const step = read("stepIndex", "x-mik-step-index")
  const index = step === undefined ? undefined : typeof step === "number" ? step : typeof step === "string" && /^\d+$/.test(step) ? Number(step) : NaN
  if (index !== undefined && (!Number.isSafeInteger(index) || index < 0)) throw new HttpError(400, "stepIndex must be a non-negative safe integer.", "INVALID_REQUEST")
  const kind = read("spanType", "x-mik-span-type")
  if (kind !== undefined && (typeof kind !== "string" || !["root", "reasoning", "tool_call", "generation"].includes(kind))) throw new HttpError(400, "Invalid spanType.", "INVALID_REQUEST")
  const fields: SpanEventMetadata = { stepIndex: index, spanType: kind as SpanEventMetadata["spanType"] }
  for (const [key, header] of [["spanId", "x-mik-span-id"], ["parentSpanId", "x-mik-parent-span-id"], ["toolName", "x-mik-tool-name"]] as const) {
    const value = read(key, header)
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 128)) throw new HttpError(400, `Invalid ${key}.`, "INVALID_REQUEST")
    const credential = req.headers.authorization?.replace(/^\S+\s+/, "")
    fields[key] = text(typeof value === "string" && credential ? value.split(credential).join("[REDACTED]") : value)
  }
  return fields
}
