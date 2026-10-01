"use client"

import { useI18n } from "@/lib/i18n/provider"

import { useEffect, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { BUDGET_TONES, budgetLevel, budgetMoney, type BudgetStatus } from "@/lib/budget"

export function BudgetPill({ showAlert = false }: { showAlert?: boolean }) {
  const { t } = useI18n()

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
  const periods = ([ [t("s23"), status?.daily], [t("s24"), status?.monthly] ] as const).filter((entry) => entry[1])
  return <div className="my-2 text-xs" data-testid={showAlert ? "overview-budget-center" : "budget-center"}>
    <details className={`rounded-xl border px-3 py-2 ${error ? "border-border text-subtle" : BUDGET_TONES[level]}`}>
      <summary className="cursor-pointer select-none rounded focus-visible:outline-2 focus-visible:outline-primary" data-testid={showAlert ? "overview-budget-pill" : "budget-pill"}>
        <span aria-hidden="true" className={`mr-2 inline-block h-2 w-2 rounded-full bg-current ${level === "warning" ? "motion-safe:animate-pulse" : ""}`} />
        {error ? t("s25") : !status ? t("s26") : periods.length === 0 ? t("s27") : periods.map(([label, period]) => `${label} ${period!.percent}%`).join(" · ")}
      </summary>
      <div className="mt-3 space-y-3">
        {periods.map(([label, period]) => period ? <div key={label} className={`rounded-lg border p-2 ${BUDGET_TONES[period.status]}`}>
          <p>{label} · {budgetMoney(period.spentMicros)} / {budgetMoney(period.limitMicros)} ({period.percent}%)</p>
          <progress aria-label={label} max={100} value={Math.min(100, period.percent)} className="mt-2 h-1.5 w-full accent-current" />
          <p className="mt-1"> {t("s28")} {budgetMoney(period.remainingMicros)} · UTC</p>
          {(period.overageMicros ?? 0) > 0 ? <p> {t("s29")} {budgetMoney(period.overageMicros!)}</p> : null}
          {period.unpricedRequests > 0 || period.archivedRequests > 0 ? <p className="mt-1"> {t("s30")} {period.unpricedRequests} {t("s31")} {period.archivedRequests} {t("s32")} </p> : null}
        </div> : null)}
        {periods.length === 0 ? <p> {t("s33")} </p> : null}
        <p> {t("s34")} </p>
      </div>
    </details>
    {showAlert && !error && level !== "ok" ? <p role="status" className={`mt-2 rounded-lg border p-3 ${BUDGET_TONES[level]}`} data-testid="budget-alert">{level === "exceeded" ? t("s35") : t("s36")}</p> : null}
  </div>
}
