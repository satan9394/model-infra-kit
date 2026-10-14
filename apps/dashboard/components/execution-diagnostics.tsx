"use client"

import { useI18n } from "@/lib/i18n/provider"
import { attemptDuration, attemptNumber, failureClass, fallbackReason, logicalId, type FailureClass } from "@/lib/diagnostics"
import { formatMs } from "@/lib/format"
import type { UsageEvent } from "@/lib/types"
import { Badge } from "@/components/ui"

const styles: Record<FailureClass, { tone: "warn" | "bad" | "info"; icon: string }> = {
  rate_limit: { tone: "warn", icon: "↻" }, timeout: { tone: "warn", icon: "◷" },
  connection: { tone: "bad", icon: "↯" }, provider_5xx: { tone: "bad", icon: "!" },
  terminal_4xx: { tone: "bad", icon: "⊘" }, budget_exceeded: { tone: "warn", icon: "$" },
  cancelled: { tone: "info", icon: "×" }, other: { tone: "bad", icon: "?" },
}

export function ErrorClassBadge({ event }: { event: UsageEvent }) {
  const { t } = useI18n()
  const category = failureClass(event)
  if (!category) return null
  const style = styles[category]
  return <span data-testid="log-error-class" data-error-class={category}><Badge tone={style.tone}><span aria-hidden="true">{style.icon} </span>{t(`diagnostics.error.${category}`)}</Badge></span>
}

export function ExecutionDiagnostics({ events, selectedId, partial, onSelect }: {
  events: UsageEvent[]; selectedId: string; partial: boolean; onSelect: (id: string) => void
}) {
  const { t } = useI18n()
  const measured = events.map(attemptDuration)
  const total = measured.reduce<number>((sum, duration) => sum + (duration ?? 0), 0)
  return <section data-testid="attempt-sequence-view" className="space-y-2">
    <h3 className="text-xs font-medium">{t("diagnostics.execution")}</h3>
    <p className="break-all font-mono text-xs text-subtle">{logicalId(events[0]) ?? events[0]?.requestId}</p>
    <p className="text-xs text-subtle" role="status">{t(!logicalId(events[0]) ? "diagnostics.unassociated" : partial ? "diagnostics.partial" : "diagnostics.retained")}</p>
    <ol className="space-y-2">
      {events.map((event, index) => {
        const duration = measured[index]
        const reason = fallbackReason(event)
        return <li key={event.requestId} className="rounded border border-border p-2">
          <button type="button" onClick={() => onSelect(event.requestId)} aria-current={selectedId === event.requestId ? "step" : undefined}
            className="w-full break-all text-left text-xs underline underline-offset-2">
            {t("diagnostics.attempt", attemptNumber(event))} · {event.providerId} · {event.modelActual || event.modelRequested}
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={event.status === "ok" ? "ok" : "bad"}>{t(event.status === "ok" ? "s68" : "s69")}</Badge>
            <ErrorClassBadge event={event} />
            <span>{t("diagnostics.duration")}: {formatMs(duration)}</span>
          </div>
          {reason && <p className="mt-2 text-xs text-subtle">{t("diagnostics.fallbackReason")}: {t(reason)}</p>}
          {duration !== undefined && total > 0 && <div aria-hidden="true" className="mt-2 h-1 rounded bg-surface-muted"><div className="h-full rounded bg-info" style={{ width: `${duration / total * 100}%` }} /></div>}
        </li>
      })}
    </ol>
  </section>
}
