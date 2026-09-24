import { ModelInfraError } from "../errors.js"

export interface KeyPoolSelection {
  /** Credential reference only; the resolved secret is never retained. */
  ref: string
  apiKey: string
}

interface PoolState {
  cursor: number
  currentRef?: string
  cooldownUntil: Map<string, number>
}

/** In-memory round-robin selection and per-reference rate-limit cooldowns. */
export class KeyPool {
  private readonly states = new Map<string, PoolState>()

  keyCount(refs: string | readonly string[] | undefined): number {
    return normalizeRefs(refs).length
  }

  resolve(
    poolId: string,
    refs: string | readonly string[],
    resolveRef: (ref: string) => string | null,
    now = Date.now(),
  ): KeyPoolSelection | undefined {
    const normalized = normalizeRefs(refs)
    if (normalized.length === 0) return undefined
    const state = this.state(poolId)
    const ordered = Array.from({ length: normalized.length }, (_, offset) => {
      const index = (state.cursor + offset) % normalized.length
      return { ref: normalized[index]!, index }
    })

    for (const candidate of ordered) {
      if ((state.cooldownUntil.get(candidate.ref) ?? 0) > now) continue
      const apiKey = resolveRef(candidate.ref)
      if (!apiKey) continue
      state.currentRef = candidate.ref
      state.cursor = (candidate.index + 1) % normalized.length
      return { ref: candidate.ref, apiKey }
    }

    const available = normalized.some((ref) => !state.cooldownUntil.has(ref))
    if (!available) {
      throw new ModelInfraError("All API keys for this provider are cooling down after rate limits.", {
        code: "RATE_LIMIT",
        retryable: true,
        providerId: poolId,
      })
    }
    throw new ModelInfraError("No configured API key reference could be resolved for this provider.", {
      code: "CREDENTIAL",
      providerId: poolId,
    })
  }

  coolCurrent(poolId: string, cooldownMs = 30_000, now = Date.now()): void {
    const state = this.states.get(poolId)
    if (!state?.currentRef) return
    const duration = Number.isFinite(cooldownMs) ? Math.max(0, cooldownMs) : 30_000
    state.cooldownUntil.set(state.currentRef, now + duration)
  }

  private state(poolId: string): PoolState {
    let state = this.states.get(poolId)
    if (!state) {
      state = { cursor: 0, cooldownUntil: new Map() }
      this.states.set(poolId, state)
    }
    return state
  }
}

/** A string keeps the historical single-ref shape; arrays and CSV are accepted. */
export function normalizeRefs(refs: string | readonly string[] | undefined): string[] {
  const values = Array.isArray(refs) ? refs : typeof refs === "string" ? refs.split(",") : []
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
