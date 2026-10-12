export interface QuotaUsage {
  currentRpm: number
  currentTpm: number
  limitRpm?: number
  limitTpm?: number
  dailySpentMicros: string
  monthlySpentMicros: string
  dailyHardCapMicros?: string
  monthlyHardCapMicros?: string
}

export interface TenantQuota extends QuotaUsage {
  appId: string
  orgId?: string
  org?: QuotaUsage
}

export interface QuotasPayload {
  quotas: TenantQuota[]
  logs: Array<{ requestId: string; ts: number; appId: string; errorCode: string }>
}

/** Convert only the bounded percentage to Number, never the monetary operands. */
export function quotaPercent(spent: string, cap?: string): number | null {
  if (cap === undefined) return null
  const used = BigInt(spent)
  const limit = BigInt(cap)
  if (limit === 0n) return 100
  if (used <= 0n) return 0
  if (used >= limit) return 100
  return Number(used * 100n / limit)
}

export function quotaRatePercent(used: number, limit?: number): number | null {
  if (limit === undefined) return null
  return limit === 0 ? 100 : Math.max(0, Math.min(100, used / limit * 100))
}
