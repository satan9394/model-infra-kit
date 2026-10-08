import type { Protocol } from "../types.js"
export { CircuitBreaker as ProviderCircuitBreaker, isRetryableRouteFailure } from "../router/circuit-breaker.js"
export type { FailoverOptions, ProviderHealthState } from "../router/circuit-breaker.js"

const CHAT_PROTOCOLS = new Set<Protocol>(["openai", "openai-compatible", "deepseek", "moonshotai", "xai"])
export function compatibleProtocols(a: Protocol | undefined, b: Protocol | undefined): boolean {
  return a === b || (!!a && !!b && CHAT_PROTOCOLS.has(a) && CHAT_PROTOCOLS.has(b))
}
