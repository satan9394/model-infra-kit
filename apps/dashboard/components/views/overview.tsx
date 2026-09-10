import Link from "next/link"
import { CostTrendChart } from "@/components/charts/cost-trend"
import { FilterPanel } from "@/components/filter-panel"
import { LiveRefresh } from "@/components/live-refresh"
import { Badge, Card, CardGrid, EmptyState, ErrorBanner, PageHeader, StatCard, TableWrap, Td, Th } from "@/components/ui"
import { formatCompact, formatInt, formatMs, formatPercent, formatUsd, tokenTotal } from "@/lib/format"
import { rangeQueryString, readFilters, resolveRange, usageQuery, type SearchParams } from "@/lib/range"
import { loadBuckets, loadShell, loadSummary, loadTrends } from "@/lib/server-data"

export interface ViewProps {
  params: SearchParams
  /** 嵌入模式：不含筛选面板，URL 区间由 embed 页面强制（默认近 7 天）。 */
  embedded?: boolean
}

export default async function OverviewView({ params, embedded }: ViewProps) {
  const range = resolveRange(params)
  const filters = readFilters(params)
  const query = usageQuery(range, filters)

  const shell = await loadShell()
  const [summary, trends, byProvider, byModel] = await Promise.all([
    loadSummary(query),
    loadTrends(query),
    loadBuckets("by-provider", query),
    loadBuckets("by-model", query),
  ])

  const upstreamErrors = [...shell.errors]
  for (const result of [summary, trends, byProvider, byModel]) {
    if (!result.ok) upstreamErrors.push(result.error)
  }

  const summaryData = summary.ok ? summary.data.summary : null
  const points = trends.ok ? trends.data.points : []
  const providerBuckets = byProvider.ok ? byProvider.data.buckets : []
  const modelBuckets = byModel.ok ? byModel.data.buckets : []
  const hasUsage = (summaryData?.requests ?? 0) > 0

  return (
    <>
      <PageHeader
        title="概览"
        description={
          <span>
            按日期区间看成本与用量 · 应用 <code className="text-slate-300">{shell.health?.appId ?? "—"}</code> ·
            供应商 <code className="text-slate-300">{shell.health?.providers ?? "—"}</code> ·
            模型 <code className="text-slate-300">{shell.health?.models ?? "—"}</code>
          </span>
        }
        actions={<LiveRefresh topics={["usage.recorded", "catalog.updated", "pricing.updated"]} ticker />}
      />

      {!embedded ? (
        <FilterPanel range={range} params={params} providers={shell.providers} models={shell.models} />
      ) : (
        <p className="mb-4 text-xs text-slate-500">
          嵌入视图 · 区间 {range.label}
          {filters.provider || filters.model ? ` · 已套用筛选` : ""}
        </p>
      )}

      {upstreamErrors.length > 0 ? (
        <ErrorBanner
          message={upstreamErrors[0] ?? "未知错误"}
          hint={
            <>
              先启动上游：<code>mik serve</code>（默认 127.0.0.1:3211），再刷新本页。
            </>
          }
        />
      ) : null}

      <CardGrid cols={3}>
        <StatCard
          label="总花费"
          value={formatUsd(summaryData?.costUsd)}
          hint={
            summaryData
              ? `区间 $${summaryData.costLowUsd.toFixed(4)} ~ $${summaryData.costHighUsd.toFixed(4)}`
              : "等待数据"
          }
        />
        <StatCard
          label="请求数"
          value={formatInt(summaryData?.requests)}
          hint={
            summaryData
              ? `成功 ${formatInt(summaryData.successes)} / 失败 ${formatInt(summaryData.failures)} · 成功率 ${formatPercent(summaryData.successRate)}`
              : "等待数据"
          }
          tone={summaryData && summaryData.failures > 0 ? "warn" : "neutral"}
        />
        <StatCard
          label="token 总量"
          value={formatCompact(summaryData ? tokenTotal(summaryData.tokens) : undefined)}
          hint={
            summaryData
              ? `input ${formatCompact(summaryData.tokens.input)} · output ${formatCompact(summaryData.tokens.output)}`
              : "等待数据"
          }
        />
        <StatCard
          label="缓存命中率"
          value={formatPercent(summaryData?.cacheHitRate)}
          hint={summaryData ? `cache_read ${formatCompact(summaryData.tokens.cacheRead)} / cache_write ${formatCompact(summaryData.tokens.cacheWrite)}` : "等待数据"}
          tone="info"
        />
        <StatCard
          label="平均延迟"
          value={formatMs(summaryData?.avgLatencyMs)}
          hint="按请求加权（服务端计算）"
        />
        <StatCard
          label="首 token 延迟"
          value={formatMs(summaryData?.firstTokenMs)}
          hint="仅统计有上报的请求"
        />
      </CardGrid>

      {!hasUsage && upstreamErrors.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="该区间还没有用量数据"
            description={
              <>
                看板显示的是 <code>mik serve</code> 里这个 appId 的真实用量。可以用假数据填满页面：
                <code className="ml-1">pnpm --filter @mik/dashboard seed</code>。
              </>
            }
          />
        </div>
      ) : null}

      <div className="mt-4">
        <Card
          title={`成本趋势（${range.label}）`}
          subtitle="按天聚合，来自 GET /api/usage/trends"
          actions={
            <Link
              href={`/trends${rangeQueryString(range)}`}
              className="text-xs text-sky-400 hover:text-sky-300"
            >
              看 token 明细 →
            </Link>
          }
        >
          <CostTrendChart points={points} />
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="按供应商" subtitle="GET /api/usage/by-provider" padded={false}>
          {providerBuckets.length === 0 ? (
            <div className="p-4">
              <EmptyState title="没有供应商数据" description="该区间内没有请求，或供应商过滤把结果清空了。" />
            </div>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>供应商</Th>
                  <Th className="text-right">请求</Th>
                  <Th className="text-right">token</Th>
                  <Th className="text-right">成本</Th>
                </tr>
              </thead>
              <tbody>
                {providerBuckets.map((bucket) => (
                  <tr key={bucket.key}>
                    <Td>
                      <Link href={`?provider=${encodeURIComponent(bucket.key)}`} className="text-slate-200 hover:text-sky-300">
                        {bucket.key || "（未标注）"}
                      </Link>
                    </Td>
                    <Td className="text-right font-mono tabular-nums">{formatInt(bucket.requests)}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatCompact(tokenTotal(bucket.tokens))}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatUsd(bucket.costUsd)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="按模型" subtitle="GET /api/usage/by-model" padded={false}>
          {modelBuckets.length === 0 ? (
            <div className="p-4">
              <EmptyState title="没有模型数据" description="该区间内没有请求，或模型过滤把结果清空了。" />
            </div>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>模型</Th>
                  <Th className="text-right">请求</Th>
                  <Th className="text-right">token</Th>
                  <Th className="text-right">成本</Th>
                </tr>
              </thead>
              <tbody>
                {modelBuckets.map((bucket) => (
                  <tr key={bucket.key}>
                    <Td>
                      <Link href={`?model=${encodeURIComponent(bucket.key)}`} className="text-slate-200 hover:text-sky-300">
                        {bucket.key || "（未标注）"}
                      </Link>
                    </Td>
                    <Td className="text-right font-mono tabular-nums">{formatInt(bucket.requests)}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatCompact(tokenTotal(bucket.tokens))}</Td>
                    <Td className="text-right font-mono tabular-nums">{formatUsd(bucket.costUsd)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>

      {shell.health ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <Badge tone={shell.health.pricing.status === "fresh" ? "ok" : "warn"}>
            pricing {shell.health.pricing.status}
          </Badge>
          <span>
            uptime {Math.round(shell.health.uptimeMs / 1000)}s · OpenAI 兼容入口{" "}
            <code className="text-slate-400">{shell.health.baseUrl}</code>
          </span>
        </div>
      ) : null}
    </>
  )
}