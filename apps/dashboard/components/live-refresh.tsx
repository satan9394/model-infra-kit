"use client"

import { useI18n } from "@/lib/i18n/provider"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { LiveBadge, useHubEvents } from "@/lib/use-events"
import { formatUsd } from "@/lib/format"
import type { HubEventFrame, UsageEvent } from "@/lib/types"
import { useConnectionProbe } from "@/components/connection-probe-provider"

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
  controlsOnly = false,
  onRefresh,
}: {
  topics: Array<HubEventFrame["type"]>
  /** Show a running "本次会话新增" counter driven by `usage.recorded` frames. */
  ticker?: boolean
  debounceMs?: number
  controlsOnly?: boolean
  onRefresh?: () => void
}) {
  const { t } = useI18n()

  const router = useRouter()
  // The reading comes from the shared provider, so the header pill and this control
  // cannot disagree and one cadence costs one request instead of one per consumer.
  const { state: probe, run } = useConnectionProbe()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [refreshes, setRefreshes] = useState(0)
  const [session, setSession] = useState({ requests: 0, costMicros: 0, lastModel: "" })
  const [announcement, setAnnouncement] = useState("")
  const previousConnected = useRef<boolean | null>(null)

  const connectionLabel = probe.status === "ready"
    ? `${t("connections.active")}: ${probe.snapshot!.requests} · ${t("connections.rtt")}: ${probe.rttMs}ms`
    : t(probe.status === "pending" ? "connections.pending" : "connections.offline")

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
          costMicros: previous.costMicros + (typeof event?.cost?.usd === "number" ? Math.round(event.cost.usd * 1_000_000) : 0),
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
  }, !controlsOnly)

  // Screen readers get the SSE connection state as a polite announcement; the
  // visual badge changes colour but colour alone is not an accessible channel.
  useEffect(() => {
    if (previousConnected.current === null) {
      previousConnected.current = state.connected
      return
    }
    if (previousConnected.current === state.connected) return
    previousConnected.current = state.connected
    setAnnouncement(state.connected ? t("a11y.liveConnected") : t("a11y.liveDisconnected"))
  }, [state.connected, t])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div aria-live="polite" className="sr-only" data-testid="live-announcer">{announcement}</div>
      {!controlsOnly ? <LiveBadge state={state} /> : null}
      {!controlsOnly ? <>
      <button
        type="button"
        data-testid="connection-probe"
        aria-label={`${t("connections.probe")} · ${connectionLabel}`}
        aria-busy={probe.status === "pending"}
        title={probe.snapshot ? `${t("connections.probe")} · ${t("connections.events")}: ${probe.snapshot.events}\n${probe.snapshot.connections.map(entry => `${entry.kind} ${entry.model} · ${Math.max(0, Math.floor((Date.now() - entry.startedAt) / 1000))}s`).join("\n")}` : t("connections.probe")}
        onClick={run}
        className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
      >
        {connectionLabel}
      </button>
      {ticker ? (
        <span className="rounded border border-border bg-surface-muted px-2 py-1 text-[11px] text-muted-foreground"> {t("s71")} <span className="font-mono text-foreground">{session.requests}</span> {t("s72")} <span className="font-mono text-foreground"> {formatUsd(session.costMicros / 1_000_000)}</span>
          {session.lastModel ? <span className="text-subtle"> {t("s73")} {session.lastModel}</span> : null}
        </span>
      ) : null}
      {refreshes > 0 ? (
        <span className="rounded border border-border bg-surface-muted px-2 py-1 text-[11px] text-subtle"> {t("s74")} {refreshes} {t("s75")} </span>
      ) : null}
      </> : null}
      <button
        type="button"
        onClick={() => {
          setRefreshes((value) => value + 1)
          router.refresh()
          onRefresh?.()
        }}
        className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
      > {t("s76")} </button>
      {state.error ? <span className="text-[11px] text-warning">{t(state.error)}</span> : null}
    </div>
  )
}
