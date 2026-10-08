import { AsyncLocalStorage } from "node:async_hooks"
import type { PricingRequestFacts } from "./tiers.js"

/** Request-local facts also cover native forwarding and streamed metering. */
export const pricingRequest = new AsyncLocalStorage<PricingRequestFacts>()
