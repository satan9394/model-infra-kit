import type { ModelInfraError } from "../errors.js"
import type { Protocol } from "../types.js"

export type ProviderHealthState = "CLOSED" | "OPEN" | "HALF_OPEN"
export interface FailoverOptions {
  failureThreshold?: number
  cooldownMs?: number
  now?: () => number
}
interface Health { state: ProviderHealthState; failures: number; openedAt: number; probing: boolean }

/** HTTP status outranks message-based SDK classification, especially for 4xx. */
export function isRetryableRouteFailure(error: ModelInfraError): boolean {
  if (error.status !== undefined) return [429, 500, 502, 503, 504].includes(error.status)
  return error.retryable && ["RATE_LIMIT", "TIMEOUT", "CONNECTION", "PROVIDER"].includes(error.code)
}

const CHAT_PROTOCOLS = new Set<Protocol>(["openai", "openai-compatible", "deepseek", "moonshotai", "xai"])
export function compatibleProtocols(a: Protocol | undefined, b: Protocol | undefined): boolean {
  return a === b || (!!a && !!b && CHAT_PROTOCOLS.has(a) && CHAT_PROTOCOLS.has(b))
}

/** Per-hub passive health: no timers, network probes, secrets or global state. */
export class ProviderCircuitBreaker {
  private readonly health = new Map<string, Health>()
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  constructor(options: FailoverOptions = {}) {
    this.threshold = options.failureThreshold ?? 3
    this.cooldownMs = options.cooldownMs ?? 30_000
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 1 || !Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1) {
      throw new Error("Failover threshold and cooldown must be positive safe integers.")
    }
  }
  state(providerId: string): ProviderHealthState {
    return this.health.get(providerId)?.state ?? "CLOSED"
  }
  available(providerId: string): boolean {
    const health = this.health.get(providerId)
    return !health || health.state === "CLOSED" || (!health.probing && this.now() - health.openedAt >= this.cooldownMs)
  }
  /** Reserve the sole HALF_OPEN probe synchronously, before awaiting transport. */
  acquire(providerId: string): boolean {
    const health = this.health.get(providerId)
    if (!health || health.state === "CLOSED") return true
    if (health.probing || this.now() - health.openedAt < this.cooldownMs) return false
    health.state = "HALF_OPEN"
    health.probing = true
    return true
  }
  success(providerId: string): void {
    this.health.delete(providerId)
  }
  failure(providerId: string, error: ModelInfraError): void {
    if (!isRetryableRouteFailure(error)) {
      if (error.status !== undefined) this.success(providerId)
      return
    }
    const health = this.health.get(providerId) ?? { state: "CLOSED", failures: 0, openedAt: 0, probing: false }
    health.failures += 1
    if (health.state === "HALF_OPEN" || health.failures >= this.threshold) {
      health.state = "OPEN"
      health.openedAt = this.now()
    }
    health.probing = false
    this.health.set(providerId, health)
  }
  /** Cancellation releases a probe without declaring provider failure/success. */
  release(providerId: string): void {
    const health = this.health.get(providerId)
    if (health?.state === "HALF_OPEN" && health.probing) {
      health.probing = false
      health.state = "OPEN"
    }
  }
}
