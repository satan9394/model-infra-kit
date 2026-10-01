"use client"

import { useI18n } from "@/lib/i18n/provider"

import { useRef, useState } from "react"
import { traceTimeline } from "@/lib/trace-timeline"
import { formatInt, formatMs, formatUsdSpan } from "@/lib/format"
import type { UsageEvent } from "@/lib/types"

export function TraceWaterfall({ events, query }: { events: UsageEvent[]; query: string }) {
  const { t } = useI18n()

  const container = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState("")
  const rows = traceTimeline(events)
  async function copy() {
    try {
      const url = `${location.origin}/api/mik/usage/logs?${query}`
      await navigator.clipboard.writeText(`curl '${url.replaceAll("'", "'\\''")}'`)
      setNotice(t("s226"))
    } catch { setNotice(t("s227")) }
  }
  return <div ref={container} className="bg-surface p-4 text-foreground" data-testid="trace-waterfall">
    <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
      <span className="text-subtle"> {t("s228")} </span>
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? t("s229") : t("s230")}</button>
      <button onClick={() => void container.current?.requestFullscreen().catch(() => setNotice(t("s231")))}> {t("s232")} </button>
      <button onClick={() => void copy()}> {t("s233")} </button>
      <span role="status">{notice}</span>
    </div>
    <div className="overflow-x-auto">
      <div className="min-w-[560px] space-y-2">
        {rows.map(({ event, left, width, ttft, reasoning, output }) => <details key={event.requestId} open={expanded} className="rounded-lg border border-border p-2">
          <summary className="grid cursor-pointer grid-cols-[140px_1fr] items-center gap-3" title={`${event.modelActual} · ${formatMs(event.latencyMs)} · input ${event.usage.input} / reasoning ${event.usage.reasoning} / output ${event.usage.output} · ${formatUsdSpan(event.cost.low, event.cost.high)}`}>
            <span className="truncate font-mono text-xs">{event.modelActual}</span>
            <span className="relative block h-5 rounded bg-surface-muted">
              <span className="absolute flex h-full overflow-hidden rounded" style={{ left: `${left}%`, width: `${width}%` }}>
                <span className="bg-slate-400/80" style={{ width: `${ttft}%` }} />
                <span className="bg-indigo-500/80" style={{ width: `${reasoning}%` }} />
                <span className="bg-emerald-500/80" style={{ width: `${output}%` }} />
              </span>
            </span>
          </summary>
          <p className="mt-2 break-all text-xs text-subtle">{event.providerId} · {event.status} · TTFT {formatMs(event.firstTokenMs)} {t("s234")} {formatMs(event.latencyMs)} · Prompt {formatInt(event.usage.input)} / Reasoning {formatInt(event.usage.reasoning)} / Completion {formatInt(event.usage.output)} · {formatUsdSpan(event.cost.low, event.cost.high)} · {event.traceId}</p>
        </details>)}
      </div>
    </div>
  </div>
}
