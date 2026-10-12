/** Literal address blocked by the SSRF guard. Hostnames resolve to allow-listed names. */
export function isForbiddenAddress(host: string): boolean {
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
