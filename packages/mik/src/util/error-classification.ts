/** Diagnostic categories, independent of routing retry policy. Never inspect upstream prose. */
export type FailureClass = "rate_limit" | "timeout" | "connection" | "provider_5xx" | "terminal_4xx" | "budget_exceeded" | "cancelled" | "other"

export function classifyFailure(code?: string, status?: number, upstreamCode?: string): FailureClass {
  if (code === "ABORTED" || code === "ABANDONED" || code === "CANCELLED") return "cancelled"
  if (code === "BUDGET_EXCEEDED") return "budget_exceeded"
  if (status === 429) return "rate_limit"
  if (status === 408 || status === 504) return "timeout"
  if (status !== undefined && status >= 400 && status < 500) return "terminal_4xx"
  if (status !== undefined && status >= 500 && status < 600) return "provider_5xx"
  if (status === undefined && upstreamCode === "server_error") return "provider_5xx"
  if (code === "RATE_LIMIT" || code === "RATE_LIMITED") return "rate_limit"
  if (code === "TIMEOUT" || code === "ETIMEDOUT") return "timeout"
  if (["CONNECTION", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code ?? "")) return "connection"
  if (["AUTH", "CREDENTIAL", "MODEL_NOT_FOUND", "INVALID_REQUEST"].includes(code ?? "")) return "terminal_4xx"
  return "other"
}
