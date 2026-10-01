import type { Store } from "../store/database.js"
import { redact } from "../util/redact.js"
import type { ModelPricingTier } from "./tiers.js"

/** Reject the cache as a unit. The bundled llm-pricing archive remains the safe baseline. */
export function verifyCatalogIntegrity(store: Store, onWarn: (message: string) => void): ModelPricingTier[] {
  try {
    return store.pricingCache.listStrict()
  } catch (error) {
    onWarn(redact(`Invalid pricing cache; using the bundled catalogue: ${error instanceof Error ? error.message : String(error)}`))
    try {
      store.pricingCache.clear()
    } catch (repairError) {
      onWarn(redact(`Could not reset pricing cache: ${repairError instanceof Error ? repairError.message : String(repairError)}`))
    }
    return []
  }
}
