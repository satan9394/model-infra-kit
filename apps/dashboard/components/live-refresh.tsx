"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { LiveBadge, useHubEvents } from "@/lib/use-events"
import { formatUsd } from "@/lib/format"
import type { HubEventFrame, UsageEvent } from "@/lib/types"

/**
 * Subscribes to `mik serve`'s SSE stream and refreshes the surrounding server
 * components when a relevant event arrives.
 *
 * `router.refresh()` re-renders the server components of the current route, so
 * the overview numbers, the price table and the model catalogue all update
 * without a page reload and without the browser holding a second data path.
 * Refreshes are debounced: a burst of usage events costs one re-render.
 */
export function LiveRefresh({
  topics,
  ticker = false,
  debounceMs = 400,
}: {
  topics: Array<HubEventFrame["type"]>
  /** Show a running "本次会话新增" counter driven by `usage.recorded` frames. */
  ticker?: boolean
  debounceMs?: number
}) {
  const router = useRouter()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [refreshes, setRefreshes] = useState(0)
  const [session, setSession] = useState({ requests: 0, cost: 0, lastModel: "" })

  const topicsRef = useRef(topics)
  topicsRef.current = topics

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setRefreshes((value) => value + 1)
      router.refresh()
    }, debounceMs)
  }

  const state = useHubEvents({
    onUsageRecorded: (frame) => {
      if (!topicsRef.current.includes("usage.recorded")) return
      if (ticker) {
        const event = frame.data as Partial<UsageEvent> | undefined
        setSession((previous) => ({
          requests: previous.requests + 1,
          cost: previous.cost + (typeof event?.cost?.usd === "number" ? event.cost.usd : 0),
          lastModel: event?.modelActual ?? event?.modelRequested ?? previous.lastModel,
        }))
      }
      schedule()
    },
    onCatalogUpdated: () => {
      if (topicsRef.current.includes("catalog.updated")) schedule()
    },
    onPricingUpdated: () => {
      if (topicsRef.current.includes("pricing.updated")) schedule()
    },
  })

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <LiveBadge state={state} />
      {ticker ? (
        <span className="rounded border border-slate-800 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-400">
          本次会话新增 <span className="font-mono text-slate-200">{session.requests}</span> 次调用 ·
          <span className="font-mono text-slate-200"> {formatUsd(session.cost)}</span>
          {session.lastModel ? <span className="text-slate-500"> · 最近 {session.lastModel}</span> : null}
        </span>
      ) : null}
      {refreshes > 0 ? (
        <span className="rounded border border-slate-800 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-500">
          已自动刷新 {refreshes} 次
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setRefreshes((value) => value + 1)
          router.refresh()
        }}
        className="rounded border border-slate-800 px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
      >
        手动刷新
      </button>
      {state.error ? <span className="text-[11px] text-amber-400">{state.error}</span> : null}
    </div>
  )
}
