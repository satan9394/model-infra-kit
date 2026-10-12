import { isForbiddenAddress } from "../util/outbound-address.js"
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
