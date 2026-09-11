import { TokenCostChart } from "@/components/charts/token-cost"
import { FilterPanel } from "@/components/filter-panel"
import { LiveRefresh } from "@/components/live-refresh"
import { Card, EmptyState, PageHeader, StatCard, TableWrap, Td, Th } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { formatCompact, formatInt, formatUsd, tokenTotal } from "@/lib/format"
import { readFilters, resolveRange, usageQuery, type SearchParams } from "@/lib/range"
import { loadShell, loadSummary, loadTrends } from "@/lib/server-data"

export interface ViewProps {
  params: SearchParams
  embedded?: boolean
}

export default async function TrendsView({ params, embedded }: ViewProps) {
  const range = resolveRange(params)
  const filters = readFilters(params)
  const query = usageQuery(range, filters)

  const shell = await loadShell()
  const [trends, summary] = await Promise.all([loadTrends(query), loadSummary(query)])

  const errors = [...shell.errors]
  if (!trends.ok) errors.push(trends.error)
  if (!summary.ok) errors.push(summary.error)

  const points = trends.ok ? trends.data.points : []
  const totals = summary.ok ? summary.data.summary : null
  const busiest = points.reduce<{ date: string; costUsd: number } | null>(
    (best, point) => (best === null || point.costUsd > best.costUsd ? { date: point.date, costUsd: point.costUsd } : best),
    null,
  )

  return (
    <>
      <PageHeader
        title="趋势"
        description="按天堆叠 input / output / cache_read / cache_write，成本用右侧轴折线表示"
        actions={<LiveRefresh topics={["usage.recorded"]} />}
      />

      {/* EVO-G09 A1: neutral guide first, error banner only after a failed retry. */}
      <UpstreamNotice message={errors[0]} />

      {!embedded ? (
        <FilterPanel range={range} params={params} providers={shell.providers} models={shell.models} />
      ) : (
        <p className="mb-4 text-xs text-slate-500">嵌入视图 · 区间 {range.label}</p>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="区间 token 合计" value={formatCompact(totals ? tokenTotal(totals.tokens) : undefined)} hint={`${points.length} 个有数据的天`} />
        <StatCard label="区间成本" value={formatUsd(totals?.costUsd)} hint="按天聚合求和" />
        <StatCard
          label="最贵的一天"
          value={busiest ? formatUsd(busiest.costUsd) : "—"}
          hint={busiest ? busiest.date : "该区间没有数据"}
        />
        <StatCard label="请求数" value={formatInt(totals?.requests)} hint="含失败请求" />
      </div>

      <Card title={`token 与成本（${range.label}）`} subtitle="GET /api/usage/trends?bucket=day">
        <TokenCostChart points={points} />
      </Card>

      <div className="mt-4">
        <Card title="按天明细" subtitle="与图表同一份数据" padded={false}>
          {points.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="该区间没有趋势数据"
                description="换一个日期区间，或先用 seed 脚本写入假数据。"
              />
            </div>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>日期</Th>
                  <Th className="text-right">请求</Th>
                  <Th className="text-right">input</Th>
                  <Th className="text-right">output</Th>
                  <Th className="text-right">cache_read</Th>
                  <Th className="text-right">cache_write</Th>
                  <Th className="text-right">成本</Th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.date}>
                    <Td className="font-mono">{point.date}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatInt(point.requests)}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatInt(point.tokens.input)}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatInt(point.tokens.output)}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatInt(point.tokens.cacheRead)}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatInt(point.tokens.cacheWrite)}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatUsd(point.costUsd)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  )
}