"use client"

import { useRef, useState } from "react"
import { traceTimeline } from "@/lib/trace-timeline"
import { formatInt, formatMs, formatUsdSpan } from "@/lib/format"
import type { UsageEvent } from "@/lib/types"

export function TraceWaterfall({ events, query }: { events: UsageEvent[]; query: string }) {
  const container = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState("")
  const rows = traceTimeline(events)
  async function copy() {
    try {
      const url = `${location.origin}/api/mik/usage/logs?${query}`
      await navigator.clipboard.writeText(`curl '${url.replaceAll("'", "'\\''")}'`)
      setNotice("已复制 / Copied")
    } catch { setNotice("复制失败 / Copy failed") }
  }
  return <div ref={container} className="bg-surface p-4 text-foreground" data-testid="trace-waterfall">
    <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
      <span className="text-subtle">TTFT · 灰 / gray · 推理估算 / estimated reasoning · 紫 / purple · 输出 / output · 绿 / green</span>
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "折叠 / Collapse" : "全展开 / Expand all"}</button>
      <button onClick={() => void container.current?.requestFullscreen().catch(() => setNotice("全屏不可用 / Fullscreen unavailable"))}>全屏 / Fullscreen</button>
      <button onClick={() => void copy()}>复制链路 cURL</button>
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
          <p className="mt-2 break-all text-xs text-subtle">{event.providerId} · {event.status} · TTFT {formatMs(event.firstTokenMs)} · 总耗时 {formatMs(event.latencyMs)} · Prompt {formatInt(event.usage.input)} / Reasoning {formatInt(event.usage.reasoning)} / Completion {formatInt(event.usage.output)} · {formatUsdSpan(event.cost.low, event.cost.high)} · {event.traceId}</p>
        </details>)}
      </div>
    </div>
  </div>
}
