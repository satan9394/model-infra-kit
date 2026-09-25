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
        title="Agent 任务链路"
        description="按 sessionId 或 traceId 汇总多轮模型调用的成本、思考 Token 与耗时；单次请求明细按时间排列。"
        actions={<LiveRefresh topics={["usage.recorded"]} />}
      />
      <UpstreamNotice message={errors[0]} />
      <FilterPanel range={range} params={params} providers={shell.providers} models={shell.models} />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3 text-sm">
        <span className="mr-1 text-xs text-subtle">聚合维度</span>
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
        <span className="ml-auto text-xs text-subtle">{range.label} · 成本按整数微美元累计</span>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="任务组" value={formatInt(groups.length)} hint={groupBy === "trace" ? "按 traceId" : "按 sessionId"} />
        <StatCard label="模型调用" value={formatInt(totalRequests)} hint="包含已归档的调用" />
        <StatCard label="Thinking Token" value={formatInt(totalReasoning)} hint="reasoning token 合计" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
        <Card title={groupBy === "trace" ? "Trace 成本" : "Session 成本"} subtitle="选择一组查看可用的逐次调用时间线" padded={false}>
          {groups.length === 0 ? (
            <div className="p-4">
              <EmptyState title="还没有 Agent 链路" description="通过 ModelRequest.traceId / sessionId，或 HTTP 端点的 trace_id / user 字段归属调用。" />
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
                      <span>{formatInt(group.requests)} 次调用</span>
                      <span>{formatInt(group.tokens.reasoning)} Thinking Token</span>
                      <span>{formatMs(group.durationMs)}</span>
                      {group.archivedRequests > 0 ? <span>{formatInt(group.archivedRequests)} 条已归档</span> : null}
                    </div>
                    <div className="mt-1 text-[10px] text-subtle/85">{formatDateTime(group.startedAt)} → {formatDateTime(group.endedAt)}</div>
                  </Link>
                )
              })}
            </div>
          )}
        </Card>

        <Card
          title={active ? `${groupBy === "trace" ? "Trace" : "Session"} · ${groupBy === "trace" ? active.traceId : active.sessionId}` : "调用时间线"}
          subtitle={active ? `${formatUsdSpan(active.costLowUsd, active.costHighUsd)} · ${formatInt(active.tokens.reasoning)} Thinking Token · ${formatInt(active.requests)} 次调用` : "先从左侧选择一个任务组"}
          padded={false}
        >
          {!active ? (
            <div className="p-4"><EmptyState title="选择 Agent 任务" description="这里会显示每次模型调用的开始时间、延迟、成本与 reasoning token。" /></div>
          ) : events.length === 0 ? (
            <div className="p-4"><EmptyState title="没有保留的请求明细" description={`${formatInt(active.archivedRequests)} 次调用仍计入上方聚合成本；每日归档后不再保留单次调用时间线。`} /></div>
          ) : (
            <div className="overflow-x-auto p-4">
              <div className="mb-3 flex flex-wrap justify-between gap-2 text-[11px] text-subtle">
                <span>时间跨度 {formatMs(active.durationMs)} · 显示 {events.length} / {formatInt(active.requests)} 次调用</span>
                {active.archivedRequests > 0 ? <span>{formatInt(active.archivedRequests)} 次较早调用已归档</span> : null}
              </div>
              <div className="mb-2 ml-[150px] h-px bg-surface-muted" />
              <div className="min-w-[640px] space-y-2">
                {events.map((event) => {
                  const start = events[0]?.ts ?? event.ts
                  const finish = events.at(-1)?.ts ?? event.ts
                  const span = Math.max(1, finish - start)
                  const left = Math.max(0, Math.min(96, ((event.ts - start) / span) * 100))
                  const width = Math.max(3, Math.min(100 - left, ((event.latencyMs ?? 1) / span) * 100))
                  return (
                    <div key={event.requestId} className="grid grid-cols-[140px_minmax(180px,1fr)_minmax(200px,0.9fr)] items-center gap-3 rounded-lg border border-border bg-surface-muted px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[11px] text-foreground/80">{event.modelActual}</div>
                        <div className="font-mono text-[10px] text-subtle/85">{formatDateTime(event.ts)}</div>
                      </div>
                      <div className="relative h-5 rounded bg-surface" aria-label={`${event.modelActual} latency ${formatMs(event.latencyMs)}`}>
                        <div className="absolute top-1 h-3 rounded bg-info/80" style={{ left: `${left}%`, width: `${width}%` }} />
                      </div>
                      <div className="flex flex-wrap justify-between gap-x-3 text-[10px] text-subtle">
                        <span>{formatMs(event.latencyMs)}</span>
                        <span>{formatInt(event.usage.reasoning)} reasoning</span>
                        <span className="font-mono text-foreground/80">{formatUsdSpan(event.cost.low, event.cost.high)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
