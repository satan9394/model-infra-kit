const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Inside an `Authorization` header, mask the credentials whatever the scheme
  // (`Bearer`, `Basic`, `Digest`, `Token`, `ApiKey`, `Negotiate`, …) — enumerating
  // schemes leaks every future one. The key may be quoted (JSON) and the value run
  // covers at most two tokens (scheme + credential), so trailing prose survives.
  [/((?:authorization)["']?\s*[=:]\s*["']?)[^\s"',;]+(?:\s+[^\s"',;]+)?/gi, "$1[REDACTED]"],
  // A bare `Bearer <credential>` outside a header. The value must *look* like a
  // credential (at least one digit or symbol), because prose such as
  // "the Bearer token is required" would otherwise get its next word masked.
  [/(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*[\d._~+/=-])[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  // key=value style; value floor is 1 char so `token=x` and `api_key=ab+/=` are covered.
  // A bare `token counts are 12` has no `=`/`:` separator and therefore never matches.
  [/((?:api[_-]?key|token|secret|password|credential|authorization)\s*[=:]\s*["']?)([^\s"',;]+)/gi, "$1[REDACTED]"],
  // known key prefixes (prefix is echoed back, the rest is masked regardless of length)
  [/\b(sk-)[A-Za-z0-9_\-]+/g, "$1****"],
  [/\b(tvly-)[A-Za-z0-9_\-]+/g, "$1****"],
  [/\b(ghp_|gho_|ghs_|ghr_|xoxb-|xoxp-|AKIA)[A-Za-z0-9_\-]+/g, "$1****"],
]

/** Replace anything that looks like a secret with a marker. */
export function redact(input: string): string {
  let output = input
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  return output
}

/** Show at most the last four characters of a secret, e.g. `sk-****abcd`. */
export function maskSecret(secret: string): string {
  if (secret.length <= 4) return "****"
  return `****${secret.slice(-4)}`
}

/**
 * A key is secret-bearing when its name *ends* with one of these fragments, so
 * prefixed custom headers (`x-api-key`, `openai-api-key`, `x-auth-token`) are
 * covered while `apiKeyRef` (a reference such as `env:FOO`, never a secret) and
 * token *counts* (`inputTokens`) are not. Case-insensitive.
 */
const SECRET_KEY_PATTERN = /(authorization|api[-_]?key|token|secret|password|cookie)s?$/i

/**
 * A value that can literally carry a secret. Token *counts* live under keys like
 * `tokens`/`prompt_tokens` and are numbers, so they must not be replaced.
 */
function carriesSecretText(value: unknown): boolean {
  if (typeof value === "string") return true
  return Array.isArray(value) && value.some((item) => typeof item === "string")
}

/** Redact every string value of a JSON-like structure, recursively. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return "[depth-limit]" as unknown as T
  if (typeof value === "string") return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as unknown as T
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] =
        SECRET_KEY_PATTERN.test(key) && carriesSecretText(item) ? "[REDACTED]" : redactDeep(item, depth + 1)
    }
    return output as unknown as T
  }
  return value
}
