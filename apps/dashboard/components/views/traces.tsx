import { getI18n } from "@/lib/i18n/server"
import { TraceWaterfall } from "@/components/trace-waterfall"
import { traceTimeline } from "@/lib/trace-timeline"
import Link from "next/link"
import { Card, EmptyState, PageHeader, StatCard, TableWrap, Td, Th } from "@/components/ui"
import { FilterPanel } from "@/components/filter-panel"
import { LiveRefresh } from "@/components/live-refresh"
import { UpstreamNotice } from "@/components/upstream-notice"
import { formatDateTime, formatInt, formatMs, formatUsdSpan } from "@/lib/format"
import { readFilters, resolveRange, usageQuery, withRange, type SearchParams } from "@/lib/range"
import { loadLogs, loadShell, loadTraces } from "@/lib/server-data"
import type { UsageTraceGroup } from "@/lib/types"

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function linkFor(
  params: SearchParams,
  range: ReturnType<typeof resolveRange>,
  groupBy: "trace" | "session",
  selected?: { key: "traceId" | "sessionId"; id: string },
): string {
  const rangeParams = withRange(params, {
    range: range.preset,
    ...(range.preset === "custom" ? { from: range.fromInput, to: range.toInput } : {}),
  })
  const search = new URLSearchParams(rangeParams.slice(1))
  search.set("groupBy", groupBy)
  if (selected) search.set(selected.key, selected.id)
  return `/traces?${search.toString()}`
}

function selectedGroup(groups: UsageTraceGroup[], groupBy: "trace" | "session", id?: string): UsageTraceGroup | undefined {
  if (!id) return undefined
  return groups.find((group) => groupBy === "trace" ? group.traceId === id : group.sessionId === id)
}

export default async function TracesView({ params }: { params: SearchParams }) {
  const { t } = await getI18n()

  const range = resolveRange(params)
  const filters = readFilters(params)
  const groupBy = first(params.groupBy) === "session" ? "session" : "trace"
  const selectedId = first(groupBy === "trace" ? params.traceId : params.sessionId)
  const query = usageQuery(range, filters)
  const shell = await loadShell()
  const [traces, logs] = await Promise.all([
    loadTraces(query, groupBy),
    selectedId
      ? (() => {
          const detailQuery = new URLSearchParams(query)
          detailQuery.set("limit", "200")
          detailQuery.set(groupBy === "trace" ? "traceId" : "sessionId", selectedId)
          return loadLogs(detailQuery.toString())
        })()
      : Promise.resolve(null),
  ])

  const errors = [...shell.errors]
  if (!traces.ok) errors.push(traces.error)
  if (logs && !logs.ok) errors.push(logs.error)
  const groups = traces.ok ? traces.data.groups : []
  const active = selectedGroup(groups, groupBy, selectedId)
  const events = logs?.ok ? [...logs.data.events].reverse() : []
  const totalRequests = groups.reduce((sum, group) => sum + group.requests, 0)
  const totalReasoning = groups.reduce((sum, group) => sum + group.tokens.reasoning, 0)

  return (
    <>
      <PageHeader
        title={t("s326")}
        description={t("s327")}
        actions={<LiveRefresh topics={["usage.recorded"]} />}
      />
      <UpstreamNotice message={errors[0]} />
      <FilterPanel range={range} params={params} providers={shell.providers} models={shell.models} />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3 text-sm">
        <span className="mr-1 text-xs text-subtle"> {t("s328")} </span>
        <Link
          href={linkFor(params, range, "trace")}
          aria-current={groupBy === "trace" ? "page" : undefined}
          className={groupBy === "trace" ? "rounded-md bg-surface-active px-3 py-1.5 text-foreground" : "rounded-md px-3 py-1.5 text-muted-foreground hover:bg-surface-muted"}
        >
          Trace
        </Link>
        <Link
          href={linkFor(params, range, "session")}
          aria-current={groupBy === "session" ? "page" : undefined}
          className={groupBy === "session" ? "rounded-md bg-surface-active px-3 py-1.5 text-foreground" : "rounded-md px-3 py-1.5 text-muted-foreground hover:bg-surface-muted"}
        >
          Session
        </Link>
        <span className="ml-auto text-xs text-subtle">{t(range.label)} {t("s329")} </span>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={t("s330")} value={formatInt(groups.length)} hint={groupBy === "trace" ? t("s331") : t("s332")} />
        <StatCard label={t("s333")} value={formatInt(totalRequests)} hint={t("s334")} />
        <StatCard label="Thinking Token" value={formatInt(totalReasoning)} hint={t("s335")} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
        <Card title={groupBy === "trace" ? t("s336") : t("s337")} subtitle={t("s338")} padded={false}>
          {groups.length === 0 ? (
            <div className="p-4">
              <EmptyState title={t("s339")} description={t("s340")} />
            </div>
          ) : (
            <div className="max-h-[680px] divide-y divide-border overflow-y-auto">
              {groups.map((group) => {
                const id = groupBy === "trace" ? group.traceId : group.sessionId
                if (!id) return null
                const href = linkFor(params, range, groupBy, { key: groupBy === "trace" ? "traceId" : "sessionId", id })
                const isActive = id === selectedId
                return (
                  <Link
                    key={group.id}
                    href={href}
                    aria-current={isActive ? "true" : undefined}
                    className={isActive ? "block bg-info/10 px-4 py-3" : "block px-4 py-3 hover:bg-surface-muted"}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="break-all font-mono text-xs text-foreground">{id}</span>
                      <span className="font-mono text-xs tabular-nums text-positive">{formatUsdSpan(group.costLowUsd, group.costHighUsd)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-subtle">
                      <span>{formatInt(group.requests)} {t("s341")} </span>
                      <span>{formatInt(group.tokens.reasoning)} Thinking Token</span>
                      <span>{formatMs(group.durationMs)}</span>
                      {group.archivedRequests > 0 ? <span>{formatInt(group.archivedRequests)} {t("s342")} </span> : null}
                    </div>
                    <div className="mt-1 text-[10px] text-subtle/85">{formatDateTime(group.startedAt)} → {formatDateTime(group.endedAt)}</div>
                  </Link>
                )
              })}
            </div>
          )}
        </Card>

        <Card
          title={active ? `${groupBy === "trace" ? "Trace" : "Session"} · ${groupBy === "trace" ? active.traceId : active.sessionId}` : t("s343")}
          subtitle={active ? t("s344", formatUsdSpan(active.costLowUsd, active.costHighUsd), formatInt(active.tokens.reasoning), formatInt(active.requests)) : t("s345")}
          padded={false}
        >
          {!active ? (
            <div className="p-4"><EmptyState title={t("s346")} description={t("s347")} /></div>
          ) : events.length === 0 ? (
            <div className="p-4"><EmptyState title={t("s348")} description={t("s349", formatInt(active.archivedRequests))} /></div>
          ) : (
            <div className="overflow-x-auto p-4">
              <div className="mb-3 flex flex-wrap justify-between gap-2 text-[11px] text-subtle">
                <span> {t("s350")} {formatMs(traceTimeline(events)[0]?.spanMs)} {t("s351")} {events.length} / {formatInt(active.requests)} {t("s341")} </span>
                {active.archivedRequests > 0 ? <span>{formatInt(active.archivedRequests)} {t("s352")} </span> : null}
              </div>
              <TraceWaterfall events={events} query={`${query}&${groupBy === "trace" ? "traceId" : "sessionId"}=${encodeURIComponent(selectedId ?? "")}`} />
              <p className="text-xs text-subtle">Reasoning {formatInt(events.reduce((sum, event) => sum + event.usage.reasoning, 0))}</p>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
