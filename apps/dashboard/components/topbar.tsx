"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { useI18n } from "@/lib/i18n/provider"
import { useConnectionProbe } from "@/components/connection-probe-provider"
import { useHubEvents } from "@/lib/use-events"
import { BudgetPill } from "@/components/budget-pill"
import { LiveRefresh } from "@/components/live-refresh"
import { LangToggle } from "@/components/lang-toggle"
import { StatusIndicator } from "@/components/status-indicator"

const TITLES: Record<string, string> = {
  "/": "s125", "/trends": "nav.usageCosts", "/logs": "s131", "/traces": "nav.traces",
  "/providers": "s87", "/models": "nav.models", "/pricing": "nav.pricing",
  "/quotas": "nav.quotas", "/webhooks": "webhooks.title", "/connect": "nav.connect",
}

export function Topbar() {
  const { t } = useI18n()
  const pathname = usePathname()
  const { state: probe, appId, refreshedAt, nextReadAt, run } = useConnectionProbe()
  const [now, setNow] = useState(0)
  const events = useHubEvents({})
  useEffect(() => {
    // Only the countdown needs a per-second tick; it stays local so the shared probe
    // does not re-render every consumer once a second.
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(clock)
  }, [])
  return <header data-testid="dashboard-topbar" className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-8">
    <div className="min-w-0">
      <p className="break-all text-xs text-muted-foreground" data-testid="topbar-app-scope">{t("status.scope")} · <code>{appId}</code></p>
      <p className="mt-1 text-base font-semibold" data-testid="topbar-page-title">{t(TITLES[`/${pathname.split("/")[1]}`] ?? "s141")}</p>
    </div>
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <StatusIndicator signal={{ kind: "gateway", status: probe.status, rttMs: probe.rttMs }} />
      <StatusIndicator signal={{ kind: "sse", ...events }} />
      <StatusIndicator signal={{ kind: "freshness", refreshedAt, now, retryInSeconds: Math.max(0, Math.ceil((nextReadAt.current - now) / 1000)) }} />
      <BudgetPill />
      <LiveRefresh topics={[]} controlsOnly onRefresh={run} />
      <LangToggle />
    </div>
  </header>
}
