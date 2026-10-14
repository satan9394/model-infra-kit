"use client"

import { ExecutionDiagnostics, ErrorClassBadge } from "@/components/execution-diagnostics"
import { attemptNumber, logicalGroups, logicalId } from "@/lib/diagnostics"
import type { LogsPayload } from "@/lib/types"
import { TraceSearch } from "@/components/trace-search"
import { useI18n } from "@/lib/i18n/provider"

import { useModalDialog } from "@/lib/use-modal-dialog"
import { useFocusTrap } from "@/components/focus-trap"
import { CacheHitBadge } from "@/components/cache-metrics"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { formatDateTime, formatInt, formatMs, formatUsd, tokenTotal } from "@/lib/format"
import type { UsageEvent } from "@/lib/types"
import { Badge, EmptyState, KeyValue, TableWrap, Td, Th } from "@/components/ui"

const PAGE_SIZES = [25, 50, 100] as const

function DetailDrawer({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const { t } = useI18n()
  const dialog = useModalDialog()
  const trapRef = useRef<HTMLElement>(null)
  useFocusTrap(trapRef, true, onClose)

  const [selectedId, setSelectedId] = useState(requestId)
  const [attempts, setAttempts] = useState<UsageEvent[]>([])
  const [partial, setPartial] = useState(false)
  const [state, setState] = useState<{ loading: boolean; event?: UsageEvent; error?: string }>({ loading: true })

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setSelectedId(requestId)
    setState({ loading: true })
    setAttempts([])
    setPartial(false)
    void (async () => {
      const result = await apiCall<{ event: UsageEvent }>(`/usage/logs/${encodeURIComponent(requestId)}`, { signal: controller.signal })
      if (cancelled) return
      setState(result.ok ? { loading: false, event: result.data.event } : { loading: false, error: "diagnostics.loadFailed" })
      if (!result.ok) return
      const event = result.data.event
      setAttempts([event])
      const id = logicalId(event)
      setPartial(!!id)
      if (!id || !event.traceId) return
      const retained: UsageEvent[] = []
      let complete = false
      // Bounded scan of retained trace rows; filters on the list must not hide earlier attempts.
      for (let offset = 0; offset < 2000; offset += 200) {
        const query = new URLSearchParams({ traceId: event.traceId, limit: "200", offset: String(offset) })
        const page = await apiCall<LogsPayload>(`/usage/logs?${query}`, { signal: controller.signal })
        if (cancelled) return
        if (!page.ok) break
        retained.push(...page.data.events.filter(row => row.appId === event.appId && logicalId(row) === id))
        if (offset + page.data.events.length >= page.data.total) { complete = true; break }
        if (!page.data.events.length) break
      }
      if (cancelled) return
      const unique = new Map(retained.map(row => [row.requestId, row]))
      unique.set(event.requestId, event)
      const sequence = logicalGroups([...unique.values()])[0]!
      setAttempts(sequence)
      setPartial(!complete || sequence.some((row, index) => attemptNumber(row) !== index + 1))
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [requestId])

  const event = attempts.find(row => row.requestId === selectedId) ?? state.event

  return (
    <dialog ref={dialog} onCancel={onClose} role="dialog" aria-modal="true" aria-labelledby="request-details-title" className="ml-auto mr-0 h-full max-h-screen w-full max-w-xl bg-surface p-0 text-foreground backdrop:bg-black/50">

      <aside ref={trapRef} tabIndex={-1} className="h-full w-full max-w-xl overflow-y-auto border-l border-border bg-surface p-4 shadow-2xl focus:outline-none motion-reduce:transition-none motion-reduce:animate-none">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 data-testid="request-details-title" id="request-details-title" className="text-sm font-medium text-foreground"> {t("s78")} </h2>
            <p className="mt-0.5 break-all font-mono text-xs text-subtle">{event?.requestId ?? requestId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border-strong px-2 py-1 text-xs text-foreground/80 hover:bg-surface-muted"
          > {t("s77")} </button>
        </div>

        {state.loading ? <p className="text-xs text-subtle"> {t("s79")} </p> : null}
        {state.error ? <p className="break-all font-mono text-xs text-danger">{t(state.error)}</p> : null}

        {event ? (
          <div className="space-y-4">
            <ExecutionDiagnostics events={attempts.length ? attempts : [event]} selectedId={event.requestId} partial={partial} onSelect={setSelectedId} />
            <section>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground"> {t("s80")} </h3>
              <KeyValue label={t("s81")}>{formatDateTime(event.ts)}</KeyValue>
              <KeyValue label="appId">{event.appId}</KeyValue>
              <KeyValue label={t("s82")}>{event.source}</KeyValue>
              <KeyValue label={t("s83")}>
                <Badge tone={event.status === "ok" ? "ok" : "bad"}>{t(event.status === "ok" ? "s68" : "s69")}</Badge>
                <ErrorClassBadge event={event} />
                {event.cacheHit ? <span className="ml-2"><CacheHitBadge label={t("cache.hitBadge")} /></span> : null}
              </KeyValue>
              <KeyValue label={t("s84")}>{event.isStreaming ? t("s85") : t("s86")}</KeyValue>
              <KeyValue label={t("s87")}>{event.providerId}</KeyValue>
              <KeyValue label={t("s88")}>{event.modelRequested}</KeyValue>
              <KeyValue label={t("s89")}>{event.modelActual}</KeyValue>
              {event.sessionId ? <KeyValue label="sessionId">{event.sessionId}</KeyValue> : null}
              {event.traceId ? <KeyValue label="traceId">{event.traceId}</KeyValue> : null}
            </section>

            <section>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground"> {t("s90")} </h3>
              <KeyValue label="input">{formatInt(event.usage.input)}</KeyValue>
              <KeyValue label="output">{formatInt(event.usage.output)}</KeyValue>
              <KeyValue label="cache_read">{formatInt(event.usage.cacheRead)}</KeyValue>
              <KeyValue label="cache_write">{formatInt(event.usage.cacheWrite)}</KeyValue>
              <KeyValue label="reasoning">{formatInt(event.usage.reasoning)}</KeyValue>
              <KeyValue label={t("s91")}>{formatInt(tokenTotal(event.usage))}</KeyValue>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground"> {t("s42")} </h3>
              <KeyValue label="usd">{formatUsd(event.cost.usd, 6)}</KeyValue>
              <KeyValue label="low / high">
                {formatUsd(event.cost.low, 6)} / {formatUsd(event.cost.high, 6)}
              </KeyValue>
              <KeyValue label="pricing_source">{event.pricingSource ?? event.cost.source}</KeyValue>
              <KeyValue label="pricing_basis">{event.pricingBasis ?? event.cost.basis}</KeyValue>
              <KeyValue label="pricing_model">{event.pricingModel ?? event.cost.pricingModel ?? "—"}</KeyValue>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground"> {t("s92")} </h3>
              <KeyValue label="latency">{formatMs(event.latencyMs)}</KeyValue>
              <KeyValue label="first token">{formatMs(event.firstTokenMs)}</KeyValue>
            </section>


          </div>
        ) : null}
      </aside>
    </dialog>
  )
}

export function LogsClient({
  events,
  total,
  limit,
  offset,
  baseQuery,
  initialId,
}: {
  events: UsageEvent[]
  total: number
  limit: number
  offset: number
  /** Current filters as a query string without `limit`/`offset`. */
  baseQuery: string
  /** Deep-link target (EVO-G143): open this recorded request detail on mount. */
  initialId?: string
}) {
  const { t } = useI18n()

  const [openId, setOpenId] = useState<string | null>(initialId ?? null)
  const page = Math.floor(offset / Math.max(1, limit)) + 1
  const pages = Math.max(1, Math.ceil(total / Math.max(1, limit)))

  const href = (nextOffset: number, nextLimit = limit) => {
    const search = new URLSearchParams(baseQuery)
    search.set("limit", String(nextLimit))
    search.set("offset", String(Math.max(0, nextOffset)))
    return `?${search.toString()}`
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-subtle">{t("diagnostics.listPolicy")}</p>
      <TraceSearch baseQuery={baseQuery} onOpen={setOpenId} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span> {t("s93")} <span className="font-mono text-foreground">{formatInt(total)}</span> {t("s94")} {page} / {pages} {t("s95")} {PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={href(0, size)}
              className={size === limit ? "ml-2 font-mono text-info" : "ml-2 font-mono text-subtle hover:text-foreground/80"}
            >
              {size}
            </Link>
          ))}
        </span>
        <span className="flex items-center gap-2">
          <Link
            href={href(offset - limit)}
            aria-disabled={offset <= 0}
            className={
              offset <= 0
                ? "pointer-events-none rounded border border-border px-2 py-1 text-subtle/85"
                : "rounded border border-border-strong px-2 py-1 text-foreground/80 hover:bg-surface-muted"
            }
          > {t("s96")} </Link>
          <Link
            href={href(offset + limit)}
            aria-disabled={offset + limit >= total}
            className={
              offset + limit >= total
                ? "pointer-events-none rounded border border-border px-2 py-1 text-subtle/85"
                : "rounded border border-border-strong px-2 py-1 text-foreground/80 hover:bg-surface-muted"
            }
          > {t("s97")} </Link>
        </span>
      </div>

      {events.length === 0 ? (
        <EmptyState
          title={t("s98")}
          description={t("s99")}
        />
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th> {t("s81")} </Th>
              <Th> {t("s100")} </Th>
              <Th className="text-right">token</Th>
              <Th className="text-right"> {t("s42")} </Th>
              <Th className="text-right"> {t("s92")} </Th>
              <Th> {t("s83")} </Th>
              <Th>requestId</Th>
            </tr>
          </thead>
          <tbody>
            {logicalGroups(events).map((group) => {
              const event = group[group.length - 1]!
              return (
              <tr
                key={event.requestId}
                onClick={(click) => {
                  click.currentTarget.querySelector<HTMLButtonElement>("button")?.focus()
                  setOpenId(event.requestId)
                }}
                className="cursor-pointer transition-colors hover:bg-surface-muted"
              >
                <Td className="whitespace-nowrap font-mono text-xs">{formatDateTime(event.ts)}</Td>
                <Td>
                  <div className="font-mono text-xs text-foreground">{event.modelActual || event.modelRequested}</div>
                  <div className="text-[11px] text-subtle">{event.providerId}</div>
                </Td>
                <Td className="text-right font-mono tabular-nums text-xs">{formatInt(tokenTotal(event.usage))}</Td>
                <Td className="text-right font-mono tabular-nums text-xs">{formatUsd(event.cost.usd)}</Td>
                <Td className="text-right font-mono tabular-nums text-xs">{formatMs(event.latencyMs)}</Td>
                <Td>
                  <Badge tone={event.status === "ok" ? "ok" : "bad"}>{t(event.status === "ok" ? "s68" : "s69")}</Badge>
                  <div className="mt-1"><ErrorClassBadge event={event} /></div>
                  {logicalId(event) && <div className="mt-1 text-[11px] text-subtle">{t("diagnostics.pageAttempts", group.length)}</div>}
                  {event.cacheHit ? <div className="mt-1"><CacheHitBadge label={t("cache.hitBadge")} /></div> : null}
                </Td>
                <Td className="max-w-[160px] truncate font-mono text-[11px] text-subtle"><button type="button" aria-label={`${t("s78")}: ${event.requestId}`} aria-haspopup="dialog" aria-expanded={openId === event.requestId} onClick={() => setOpenId(event.requestId)} className="underline">{event.requestId}</button></Td>
              </tr>
            )})}
          </tbody>
        </TableWrap>
      )}

      {openId ? <DetailDrawer requestId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  )
}
