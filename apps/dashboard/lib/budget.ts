export type BudgetLevel = "ok" | "warning" | "exceeded"
export interface BudgetPeriod {
  spentMicros: number
  limitMicros: number
  remainingMicros: number
  overageMicros?: number
  percent: number
  status: BudgetLevel
  from: number
  to: number
  unpricedRequests: number
  archivedRequests: number
  historicalAllocationLimited?: boolean
}
export interface BudgetStatus {
  currency: "USD"
  advisory: true
  daily: BudgetPeriod | null
  monthly: BudgetPeriod | null
}
export const BUDGET_TONES: Record<BudgetLevel, string> = {
  ok: "border-positive/30 bg-positive/10 text-positive",
  warning: "border-warning/40 bg-warning/10 text-warning",
  exceeded: "border-danger/40 bg-danger/10 text-danger",
}
export function budgetLevel(status: BudgetStatus): BudgetLevel {
  const levels = [status.daily?.status, status.monthly?.status]
  return levels.includes("exceeded") ? "exceeded" : levels.includes("warning") ? "warning" : "ok"
}
/** Display only: arithmetic and accumulation stay in integer micros. */
export function budgetMoney(micros: number): string {
  const amount = BigInt(micros)
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  return `${negative ? "−" : ""}$${abs / 1_000_000n}.${String(abs % 1_000_000n).padStart(6, "0")}`
}
