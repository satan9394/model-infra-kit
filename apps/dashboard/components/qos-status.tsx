"use client"

import { useI18n } from "@/lib/i18n/provider"
import type { EndpointQoSStats } from "@/lib/qos"

export function QoSStatus({ channels, unavailable = false, now = Date.now() }: { channels: EndpointQoSStats[]; unavailable?: boolean; now?: number }) {
  const { t } = useI18n()
  if (unavailable || !channels.length) return <span data-testid="qos-status" className="text-[10px] text-subtle">{t(unavailable ? "qos.unavailable" : "qos.waiting")}</span>
  return <div className="flex flex-wrap gap-1.5" data-testid="qos-status">
    {channels.map(s => {
      const stale = !s.sampleCount || now - s.lastUpdated > 30_000
      const status = stale ? "waiting" : s.qosScore >= 75 ? "healthy" : s.qosScore >= 50 ? "variable" : "degraded"
      const tone = stale ? "text-subtle bg-surface-muted" : status === "healthy" ? "text-positive bg-positive/10" : status === "variable" ? "text-warning bg-warning/10" : "text-latency-slow bg-latency-slow/10"
      return <span key={`${s.providerId}:${s.modelId}`} className={`max-w-full break-all rounded-lg px-2 py-1 text-[10px] ${tone}`}>
        <span className="font-mono">{s.modelId}</span> · {t(`qos.${status}`)}
        {!stale && <><span className="ml-1 font-mono">{t("qos.rtt")} {Math.round(s.ewmaRttMs)} ms · {t("qos.weight")} {s.effectiveWeight}</span>
          <span className="mt-0.5 block">{t("qos.ttft")} {s.ewmaTtftMs === null ? "—" : `${Math.round(s.ewmaTtftMs)} ms`} · {t("qos.jitter")} {Math.round(s.jitterMs)} ms · {t("qos.success")} {Math.round(s.successRate * 100)}% · {t("qos.score")} {s.qosScore}</span></>}
      </span>
    })}
  </div>
}
