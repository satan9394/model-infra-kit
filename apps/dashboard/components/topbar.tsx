"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { useI18n } from "@/lib/i18n/provider"
import { connectionAppScope, createConnectionProbe, type ProbeState } from "@/lib/connection-probe"
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
  const [probe, setProbe] = useState<ProbeState>({ status: "pending", snapshot: null, rttMs: null })
  const [appId, setAppId] = useState("default")
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const nextReadAt = useRef(0)
  const connection = useRef<ReturnType<typeof createConnectionProbe> | null>(null)
  const events = useHubEvents({})
  useEffect(() => {
    const reader = createConnectionProbe(state => {
      setProbe(state)
      if (state.status === "ready") {
        setAppId(connectionAppScope(state.snapshot!))
        setRefreshedAt(Date.now())
      }
      setNow(Date.now())
    })
    connection.current = reader
    nextReadAt.current = Date.now() + 15_000
    void reader.run()
    const poll = setInterval(() => { nextReadAt.current = Date.now() + 15_000; if (!document.hidden) void reader.run() }, 15_000)
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    return () => { clearInterval(poll); clearInterval(clock); reader.dispose(); connection.current = null }
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
      <LiveRefresh topics={[]} controlsOnly onRefresh={() => { void connection.current?.run() }} />
      <LangToggle />
    </div>
  </header>
}
