import { HttpError } from "./context.js"

/**
 * SSRF guard for server routes that make outbound provider calls. Only
 * http(s) is allowed, and literal link-local/cloud-metadata addresses are
 * refused. Loopback remains valid for local providers and test servers.
 */
export function assertSafeOutboundUrl(value: string | undefined, what: string): void {
  if (value === undefined || value.trim() === "") return
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new HttpError(400, `"${what}" is not a valid URL.`, "INVALID_REQUEST")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, `"${what}" must use http(s), not "${url.protocol}".`, "INVALID_REQUEST")
  }
  if (isForbiddenAddress(url.hostname)) {
    throw new HttpError(
      400,
      `"${what}" points at a link-local or cloud-metadata address and is refused.`,
      "INVALID_REQUEST",
    )
  }
}

/** Literal address blocked by the SSRF guard. Hostnames resolve to allow-listed names. */
function isForbiddenAddress(host: string): boolean {
  const value = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  const lower = value.toLowerCase()
  if (lower === "0.0.0.0" || lower === "::" || lower === "::0") return true
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the same address as the quad.
  if (lower.startsWith("::ffff:")) return isForbiddenAddress(lower.slice(7))
  if (lower.includes(":")) {
    // fe80::/10 → the first hextet is fe8x–febx. `::1` (loopback) is allowed.
    return /^fe[89ab][0-9a-f]/.test(lower)
  }
  const parts = lower.split(".")
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  // Cloud metadata / link-local: 169.254.0.0/16. Loopback 127.0.0.0/8 is allowed.
  return octets[0] === 169 && octets[1] === 254
}
