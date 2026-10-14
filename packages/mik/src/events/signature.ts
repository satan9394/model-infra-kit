import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Webhook request signing (EVO-G144 extraction).
 *
 * Kept in its own module so the durable outbox worker can sign a delivery
 * without importing the dispatcher — that would make `events/webhook.ts` and
 * `events/outbox.ts` mutually dependent (`module-graph.test.ts` forbids cycles).
 */

/** Sign timestamp + exact wire bytes, so neither can be replaced independently. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
}

/** Verify a signature within a ±5 minute replay window. Never throws on malformed input. */
export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string, now = Date.now()): boolean {
  if (!/^\d{1,13}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(signature)
    || !Number.isFinite(now) || Math.abs(now - Number(timestamp) * 1000) > 300_000) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(webhookSignature(secret, timestamp, body)))
}
