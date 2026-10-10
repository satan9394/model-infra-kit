import type { SpanEventMetadata } from "../types.js"
import { redact } from "../util/redact.js"

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? redact(value.trim()).slice(0, 128) : undefined

/** Whitelist metadata on both storage boundaries; never retain arguments or responses. */
export function sanitizeSpan(value: SpanEventMetadata, requestId: string): SpanEventMetadata {
  return {
    spanId: text(value.spanId) ?? text(requestId), parentSpanId: text(value.parentSpanId),
    spanType: ["root", "reasoning", "tool_call", "generation"].includes(value.spanType ?? "") ? value.spanType : "generation",
    stepIndex: Number.isSafeInteger(value.stepIndex) && value.stepIndex! >= 0 ? value.stepIndex : 0,
    toolName: text(value.toolName),
  }
}
