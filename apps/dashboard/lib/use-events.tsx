"use client"

import { useEffect, useRef, useState } from "react"
import type { HubEventFrame } from "@/lib/types"

export interface HubEventsHandlers {
  onUsageRecorded?: (frame: HubEventFrame) => void
  onCatalogUpdated?: (frame: HubEventFrame) => void
  onPricingUpdated?: (frame: HubEventFrame) => void
}

export interface HubEventsState {
  /** True once the SSE connection is open. */
  connected: boolean
  /** Timestamp of the last frame of any type, for the "live" indicator. */
  lastEventAt: number | null
  lastEventType: HubEventFrame["type"] | null
  /** Set when the browser reports an error (EventSource retries by itself). */
  error: string | null
}

/**
 * Subscribe to `mik serve`'s `/api/events` through the dashboard's own proxy.
 *
 * `EventSource` reconnects on its own, so a mik restart is picked up without a
 * page reload; `connected` only reflects the browser's view of the stream.
 */
export function useHubEvents(handlers: HubEventsHandlers): HubEventsState {
  const ref = useRef(handlers)
  ref.current = handlers
  const [state, setState] = useState<HubEventsState>({
    connected: false,
    lastEventAt: null,
    lastEventType: null,
    error: null,
  })

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return
    const source = new EventSource("/api/events")

    const handle = (type: HubEventFrame["type"]) => (event: MessageEvent<string>) => {
      let frame: HubEventFrame
      try {
        const parsed = JSON.parse(event.data) as unknown
        frame =
          parsed && typeof parsed === "object" && "type" in (parsed as Record<string, unknown>)
            ? (parsed as HubEventFrame)
            : { type, at: Date.now(), data: parsed }
      } catch {
        frame = { type, at: Date.now(), data: event.data }
      }
      setState((previous) => ({ ...previous, lastEventAt: Date.now(), lastEventType: frame.type, error: null }))
      if (frame.type === "usage.recorded") ref.current.onUsageRecorded?.(frame)
      if (frame.type === "catalog.updated") ref.current.onCatalogUpdated?.(frame)
      if (frame.type === "pricing.updated") ref.current.onPricingUpdated?.(frame)
    }

    const onUsage = handle("usage.recorded")
    const onCatalog = handle("catalog.updated")
    const onPricing = handle("pricing.updated")
    const onOpen = () => setState((previous) => ({ ...previous, connected: true, error: null }))
    const onError = () =>
      setState((previous) => ({ ...previous, connected: false, error: "事件流已断开，正在重连…" }))

    source.addEventListener("open", onOpen)
    source.addEventListener("error", onError)
    source.addEventListener("usage.recorded", onUsage as EventListener)
    source.addEventListener("catalog.updated", onCatalog as EventListener)
    source.addEventListener("pricing.updated", onPricing as EventListener)

    return () => {
      source.removeEventListener("open", onOpen)
      source.removeEventListener("error", onError)
      source.removeEventListener("usage.recorded", onUsage as EventListener)
      source.removeEventListener("catalog.updated", onCatalog as EventListener)
      source.removeEventListener("pricing.updated", onPricing as EventListener)
      source.close()
    }
  }, [])

  return state
}

export function LiveBadge({ state }: { state: HubEventsState }) {
  const tone = state.connected
    ? "border-emerald-800/70 bg-emerald-950/60 text-emerald-300"
    : "border-slate-700 bg-slate-800/60 text-slate-400"
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] ${tone}`}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${state.connected ? "bg-emerald-400" : "bg-slate-500"}`}
      />
      {state.connected ? "实时" : "未连接"}
      {state.lastEventAt ? <span className="text-slate-500">· {new Date(state.lastEventAt).toLocaleTimeString("zh-CN")}</span> : null}
    </span>
  )
}
