"use client"

import { useI18n } from "@/lib/i18n/provider"

type StatusSignal =
  | { kind: "gateway"; status: "pending" | "ready" | "offline"; rttMs: number | null }
  | { kind: "sse"; connected: boolean; error: string | null; lastEventAt: number | null }
  | { kind: "freshness"; refreshedAt: number | null; now: number; retryInSeconds?: number }
  | { kind: "probe"; outcome: "success" | "failed" | null; testedAt: number | null }
  | { kind: "circuit"; state: "CLOSED" | "OPEN" | "HALF_OPEN" | null; healthKey?: string; unavailable?: boolean }

/** Each signal keeps its own source; a transport result never implies provider health. */
export function StatusIndicator({ signal }: { signal: StatusSignal }) {
  const { t, lang } = useI18n()
  const time = (at: number | null) => at === null ? t("status.never") : new Date(at).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US")
  let label: string
  let detail: string
  let tone = "text-muted-foreground border-border"
  if (signal.kind === "gateway") {
    label = `${t("status.gateway")} · ${t(`status.${signal.status}`)}${signal.status === "ready" && signal.rttMs !== null ? ` · ${signal.rttMs} ms` : ""}`
    detail = t("status.gatewayDetail")
    tone = signal.status === "ready" ? "text-positive border-positive/30" : signal.status === "offline" ? "text-danger border-danger/30" : tone
  } else if (signal.kind === "sse") {
    label = `SSE · ${t(signal.connected ? "status.connected" : signal.error ? "status.reconnecting" : "status.disconnected")}`
    detail = `${t("status.sseDetail")} · ${t("status.lastEvent", time(signal.lastEventAt))}`
    tone = signal.connected ? "text-positive border-positive/30" : "text-warning border-warning/30"
  } else if (signal.kind === "freshness") {
    const fresh = signal.refreshedAt !== null && signal.now - signal.refreshedAt < 30_000
    label = t(fresh ? "status.fresh" : "status.stale")
    detail = t("status.freshnessDetail", time(signal.refreshedAt))
    if (signal.retryInSeconds !== undefined) detail += ` · ${t("status.nextRead", signal.retryInSeconds)}`
    tone = fresh ? tone : "text-warning border-warning/30"
  } else if (signal.kind === "probe") {
    label = `${t("status.activeProbe")} · ${t(signal.outcome === null ? "status.never" : `status.${signal.outcome}`)}`
    detail = t("status.probeDetail", time(signal.testedAt))
  } else {
    label = `${t("status.instanceCircuit")} · ${signal.unavailable ? t("status.offline") : signal.state ?? t("status.never")}${signal.healthKey ? ` · ${signal.healthKey}` : ""}`
    detail = t("status.circuitDetail")
    tone = signal.state === "CLOSED" ? tone : "text-warning border-warning/30"
  }
  return <span data-testid={`${signal.kind === "freshness" ? "data-freshness" : signal.kind}-status-pill`} title={detail} aria-label={`${label}. ${detail}`} className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${tone}`}>
    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
    <span>{label}</span>
  </span>
}
