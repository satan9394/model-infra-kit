import { FilterPanel } from "@/components/filter-panel"
import { LiveRefresh } from "@/components/live-refresh"
import { LogsClient } from "@/components/logs-client"
import { ErrorBanner, PageHeader } from "@/components/ui"
import { readFilters, resolveRange, usageQuery, type SearchParams } from "@/lib/range"
import { loadLogs, loadShell } from "@/lib/server-data"

export interface ViewProps {
  params: SearchParams
  embedded?: boolean
}

const DEFAULT_LIMIT = 50

export default async function LogsView({ params, embedded }: ViewProps) {
  const range = resolveRange(params)
  const filters = readFilters(params)
  const limit = filters.limit ?? DEFAULT_LIMIT
  const offset = filters.offset ?? 0

  const shell = await loadShell()
  const logs = await loadLogs(usageQuery(range, { ...filters, limit, offset }))

  const errors = [...shell.errors]
  if (!logs.ok) errors.push(logs.error)

  const baseQuery = usageQuery(range, { provider: filters.provider, model: filters.model, status: filters.status })

  return (
    <>
      <PageHeader
        title="请求日志"
        description="点任意一行查看详情抽屉：四类 token、四项成本、pricing_source / pricing_basis 与延迟"
        actions={<LiveRefresh topics={["usage.recorded"]} />}
      />
      {!embedded ? (
        <FilterPanel range={range} params={params} providers={shell.providers} models={shell.models} />
      ) : (
        <p className="mb-4 text-xs text-slate-500">嵌入视图 · 区间 {range.label}</p>
      )}
      {errors.length > 0 ? <ErrorBanner message={errors[0] ?? "未知错误"} /> : null}
      <LogsClient
        events={logs.ok ? logs.data.events : []}
        total={logs.ok ? logs.data.total : 0}
        limit={logs.ok ? logs.data.limit : limit}
        offset={logs.ok ? logs.data.offset : offset}
        baseQuery={baseQuery}
      />
    </>
  )
}