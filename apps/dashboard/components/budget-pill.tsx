"use client"

import { useEffect, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { BUDGET_TONES, budgetLevel, budgetMoney, type BudgetStatus } from "@/lib/budget"

export function BudgetPill({ showAlert = false }: { showAlert?: boolean }) {
  const [status, setStatus] = useState<BudgetStatus | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    async function load() {
      const result = await apiCall<BudgetStatus>("/budget/status")
      if (!active) return
      setError(!result.ok)
      if (result.ok) setStatus(result.data)
    }
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const level = status ? budgetLevel(status) : "ok"
  const periods = ([ ["今日 / Daily", status?.daily], ["本月 / Monthly", status?.monthly] ] as const).filter((entry) => entry[1])
  return <div className="my-2 text-xs" data-testid={showAlert ? "overview-budget-center" : "budget-center"}>
    <details className={`rounded-xl border px-3 py-2 ${error ? "border-border text-subtle" : BUDGET_TONES[level]}`}>
      <summary className="cursor-pointer select-none rounded focus-visible:outline-2 focus-visible:outline-primary" data-testid={showAlert ? "overview-budget-pill" : "budget-pill"}>
        <span aria-hidden="true" className={`mr-2 inline-block h-2 w-2 rounded-full bg-current ${level === "warning" ? "motion-safe:animate-pulse" : ""}`} />
        {error ? "预算状态不可用 / Budget unavailable" : !status ? "预算加载中 / Loading budget" : periods.length === 0 ? "软预算未配置 / Budget off" : periods.map(([label, period]) => `${label} ${period!.percent}%`).join(" · ")}
      </summary>
      <div className="mt-3 space-y-3">
        {periods.map(([label, period]) => period ? <div key={label} className={`rounded-lg border p-2 ${BUDGET_TONES[period.status]}`}>
          <p>{label} · {budgetMoney(period.spentMicros)} / {budgetMoney(period.limitMicros)} ({period.percent}%)</p>
          <progress aria-label={label} max={100} value={Math.min(100, period.percent)} className="mt-2 h-1.5 w-full accent-current" />
          <p className="mt-1">剩余 / Remaining {budgetMoney(period.remainingMicros)} · UTC</p>
          {(period.overageMicros ?? 0) > 0 ? <p>超支 / Overage {budgetMoney(period.overageMicros!)}</p> : null}
          {period.unpricedRequests > 0 || period.archivedRequests > 0 ? <p className="mt-1">对账提醒 / Reconciliation: {period.unpricedRequests} 未定价 / unpriced · {period.archivedRequests} 已归档 / archived。历史金额与 UTC 窗口归属可能不完整 / Historical amounts and UTC allocation may be incomplete.</p> : null}
        </div> : null)}
        {periods.length === 0 ? <p>在 mik.config.json 中设置 budget.dailyMicros / monthlyMicros。</p> : null}
        <p>仅提示；不会阻断任何请求 / Advisory only; requests continue.</p>
      </div>
    </details>
    {showAlert && !error && level !== "ok" ? <p role="status" className={`mt-2 rounded-lg border p-3 ${BUDGET_TONES[level]}`} data-testid="budget-alert">{level === "exceeded" ? "已超出软配额，但未阻断任何请求 / Soft budget exceeded; requests continue." : "已使用至少 80% 软预算 / At least 80% of the soft budget used."}</p> : null}
  </div>
}
