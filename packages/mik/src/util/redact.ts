const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // key=value style
  [/((?:api[_-]?key|token|secret|password|credential|authorization)\s*[=:]\s*["']?)([^\s"',;]{4,})/gi, "$1[REDACTED]"],
  // known key prefixes
  [/\b(sk-[A-Za-z0-9_\-]{8,})/g, "sk-****"],
  [/\b(tvly-[A-Za-z0-9_\-]{8,})/g, "tvly-****"],
  [/\b(ghp_|gho_|ghs_|ghr_|xoxb-|xoxp-|AKIA)[A-Za-z0-9_\-]{8,}/g, "$1****"],
  [/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1[REDACTED]"],
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

/** Redact every string value of a JSON-like structure, recursively. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return "[depth-limit]" as unknown as T
  if (typeof value === "string") return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as unknown as T
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = /^(authorization|api[_-]?key|token|secret|password)$/i.test(key) ? "[REDACTED]" : redactDeep(item, depth + 1)
    }
    return output as unknown as T
  }
  return value
}
