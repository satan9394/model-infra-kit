import type { BudgetConfig } from "../types.js"

export type BudgetStatusLevel = "ok" | "warning" | "exceeded"

/** Integer micro-USD totals read from the usage store for one UTC window. */
export interface BudgetUsageTotals {
  spentMicros: number
  unpricedRequests: number
  archivedRequests: number
  /** Rollups use local calendar dates, so their UTC allocation is approximate. */
  historicalAllocationLimited: boolean
}

/** A deterministic usage snapshot accepted by {@link checkBudgetStatus}. */
export interface BudgetUsageSnapshot {
  daily: BudgetUsageTotals
  monthly: BudgetUsageTotals
}

/** A read-only usage source, implemented by `UsageService`. */
export interface BudgetUsageReader {
  budgetTotals(from: number, to: number): BudgetUsageTotals
}

export interface BudgetPeriod {
  spentMicros: number
  limitMicros: number
  remainingMicros: number
  /** Integer micro-USD above the configured limit; zero while within budget. */
  overageMicros: number
  /** Whole percentage points, floored with integer arithmetic. */
  percent: number
  status: BudgetStatusLevel
  from: number
  to: number
  unpricedRequests: number
  archivedRequests: number
  /** True when retained local-date rollups are included in a UTC range. */
  historicalAllocationLimited: boolean
}

export interface BudgetStatus {
  currency: "USD"
  advisory: true
  daily: BudgetPeriod | null
  monthly: BudgetPeriod | null
}

type BudgetUsageInput = BudgetUsageReader | BudgetUsageSnapshot

const MICROS_PER_USD = 1_000_000
const PERCENT_WARNING = 80

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function validLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function checkedTotals(value: BudgetUsageTotals): BudgetUsageTotals {
  if (
    !Number.isSafeInteger(value.spentMicros) ||
    value.spentMicros < 0 ||
    !Number.isSafeInteger(value.unpricedRequests) ||
    value.unpricedRequests < 0 ||
    !Number.isSafeInteger(value.archivedRequests) ||
    value.archivedRequests < 0 ||
    typeof value.historicalAllocationLimited !== "boolean"
  ) {
    throw new RangeError("budget usage totals must contain non-negative safe integer micros and request counts")
  }
  return value
}

function legacyLimitMicros(config: BudgetConfig, window: "day" | "month"): number | undefined {
  if (config.usd === undefined || typeof config.usd !== "number" || !Number.isFinite(config.usd) || config.usd <= 0) {
    return undefined
  }
  if ((config.window ?? "day") !== window) return undefined
  const micros = Math.round(config.usd * MICROS_PER_USD)
  return Number.isSafeInteger(micros) && micros > 0 ? micros : undefined
}

function limitFor(config: BudgetConfig, window: "day" | "month"): number | undefined {
  const configured = window === "day" ? config.dailyMicros : config.monthlyMicros
  // An explicitly supplied invalid micros limit is invalid; do not silently
  // fall back to the legacy USD field and show a different quota than asked.
  if (configured !== undefined) return validLimit(configured)
  return legacyLimitMicros(config, window)
}

function utcRange(window: "day" | "month", now: number): { from: number; to: number } {
  const date = new Date(now)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  if (window === "month") {
    return { from: Date.UTC(year, month, 1), to: Date.UTC(year, month + 1, 1) }
  }
  const from = Date.UTC(year, month, date.getUTCDate())
  return { from, to: from + 86_400_000 }
}

function validTimestamp(now: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new RangeError("budget status time must be a finite, valid Date timestamp")
  }
  return now
}

function totalsFor(usage: BudgetUsageInput, from: number, to: number, window: "day" | "month"): BudgetUsageTotals {
  if ("budgetTotals" in usage) return checkedTotals(usage.budgetTotals(from, to))
  return checkedTotals(window === "day" ? usage.daily : usage.monthly)
}

function period(
  totals: BudgetUsageTotals,
  limitMicros: number | undefined,
  range: { from: number; to: number },
): BudgetPeriod | null {
  if (limitMicros === undefined) return null
  const spentMicros = safeInteger(totals.spentMicros)
  const remainingMicros = spentMicros >= limitMicros ? 0 : limitMicros - spentMicros
  const overageMicros = spentMicros > limitMicros ? spentMicros - limitMicros : 0
  const percentBig = (BigInt(spentMicros) * 100n) / BigInt(limitMicros)
  const percent = percentBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(percentBig)
  const status: BudgetStatusLevel = spentMicros >= limitMicros ? "exceeded" : percent >= PERCENT_WARNING ? "warning" : "ok"
  return {
    spentMicros,
    limitMicros,
    remainingMicros,
    overageMicros,
    percent,
    status,
    from: range.from,
    to: range.to,
    unpricedRequests: safeInteger(totals.unpricedRequests),
    archivedRequests: safeInteger(totals.archivedRequests),
    historicalAllocationLimited: Boolean(totals.historicalAllocationLimited),
  }
}

/**
 * Compute the advisory budget status without changing usage state.
 *
 * A `BudgetUsageSnapshot` makes this function pure and easy to test. Passing a
 * `UsageService` (or another `BudgetUsageReader`) is the convenience form used
 * by `ModelInfra.budgetStatus()`; the reader is only queried for integer store
 * totals and no request path is blocked.
 */
export function checkBudgetStatus(usage: BudgetUsageInput, config: BudgetConfig | undefined, now = Date.now()): BudgetStatus {
  const result: BudgetStatus = { currency: "USD", advisory: true, daily: null, monthly: null }
  if (!config || (config.currency !== undefined && config.currency !== "USD")) return result
  validTimestamp(now)

  const dailyRange = utcRange("day", now)
  const monthlyRange = utcRange("month", now)
  const dailyLimit = limitFor(config, "day")
  const monthlyLimit = limitFor(config, "month")
  if (dailyLimit !== undefined) result.daily = period(totalsFor(usage, dailyRange.from, dailyRange.to, "day"), dailyLimit, dailyRange)
  if (monthlyLimit !== undefined) {
    result.monthly = period(
      totalsFor(usage, monthlyRange.from, monthlyRange.to, "month"),
      monthlyLimit,
      monthlyRange,
    )
  }
  return result
}
