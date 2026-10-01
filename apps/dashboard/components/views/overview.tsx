import Link from "next/link"
import { CostTrendChart } from "@/components/charts/cost-trend"
import { FilterPanel } from "@/components/filter-panel"
import { LiveRefresh } from "@/components/live-refresh"
import { Badge, Card, CardGrid, EmptyState, PageHeader, StatCard, TableWrap, Td, Th } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { formatCompact, formatInt, formatMs, formatPercent, formatUsd, formatUsdSpan, tokenTotal } from "@/lib/format"
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
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>应用 <code className="text-foreground/80">{shell.health?.appId ?? "—"}</code></span>
            <span><span className="tabular-nums">{shell.health?.providers ?? "—"}</span> 个供应商</span>
            <span><span className="tabular-nums">{shell.health?.models ?? "—"}</span> 个模型</span>
          </span>
        }
        actions={<LiveRefresh topics={["usage.recorded", "catalog.updated", "pricing.updated"]} ticker />}
      />

      {/* EVO-G09 A1: on first paint with a dead upstream the *first* block is this
          neutral guide; the red banner is demoted to a reaction to "重试". */}
      <UpstreamNotice message={upstreamErrors[0]} />

      {!embedded ? (
        <FilterPanel range={range} params={params} providers={shell.providers} models={shell.models} />
      ) : (
        <p className="mb-4 text-xs text-subtle">
          嵌入视图 · 区间 {range.label}
          {filters.provider || filters.model ? ` · 已套用筛选` : ""}
        </p>
      )}

      <CardGrid cols={3}>
        {/* EVO-G89: the headline amount is the recorded band, never the deprecated
            point estimate (`UsageSummary.costUsd`, which bounds nothing once
            anything is unpriced or folded). A point-priced install records
            `low === high`, so this renders what it always did; a band renders
            `$a ~ $b`, the same shape as the interval hint below.
            `testId` is the hook the DASH check in `scripts/e2e/run.mjs` anchors
            its band assertion on: the two shapes are identical strings whenever
            every row is point-priced, which is why "the cell prints the band"
            needs a cell-level anchor and a genuinely spread row to prove it. */}
        <StatCard
          label="总花费"
          featured
          testId="overview-cost-span"
          value={formatUsdSpan(summaryData?.costLowUsd, summaryData?.costHighUsd)}
          hint={
            summaryData
              ? `区间 ${formatUsd(summaryData.costLowUsd)} ~ ${formatUsd(summaryData.costHighUsd)}`
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
          label="Token 总量"
          value={formatCompact(summaryData ? tokenTotal(summaryData.tokens) : undefined)}
          hint={
            summaryData
              ? `输入 ${formatCompact(summaryData.tokens.input)} · 输出 ${formatCompact(summaryData.tokens.output)}`
              : "等待数据"
          }
        />
      </CardGrid>

      {!hasUsage && upstreamErrors.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title="该区间还没有用量数据"
            description="先完成一次模型调用，或调整日期和筛选条件。看板只显示当前应用记录的用量。"
          />
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_260px]">
        <Card
          title={`成本趋势（${range.label}）`}
          subtitle="按天聚合的成本点估计；记录区间见上方总花费"
          className="min-w-0"
          actions={
            <Link
              href={`/trends${rangeQueryString(range)}`}
              className="rounded-md px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              查看用量明细
            </Link>
          }
        >
          <CostTrendChart points={points} height={280} />
        </Card>
        <Card title="运行表现" subtitle="当前区间的缓存与响应效率">
          <dl className="divide-y divide-border/70">
            <div className="pb-5">
              <dt className="text-xs text-muted-foreground">缓存命中率</dt>
              <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-primary">
                {formatPercent(summaryData?.cacheHitRate)}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-subtle">
                {summaryData ? `读取 ${formatCompact(summaryData.tokens.cacheRead)} · 写入 ${formatCompact(summaryData.tokens.cacheWrite)}` : "等待数据"}
              </dd>
            </div>
            <div className="py-5">
              <dt className="text-xs text-muted-foreground">平均延迟</dt>
              <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                {formatMs(summaryData?.avgLatencyMs)}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-subtle">按请求加权计算</dd>
            </div>
            <div className="pt-5">
              <dt className="text-xs text-muted-foreground">首 Token 延迟</dt>
              <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                {formatMs(summaryData?.firstTokenMs)}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-subtle">仅统计有上报的请求</dd>
            </div>
          </dl>
        </Card>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="供应商用量" subtitle="查看各供应商的调用与记录成本" padded={false} className="min-w-0">
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
                      <Link href={`?provider=${encodeURIComponent(bucket.key)}`} className="text-foreground hover:text-info">
                        {bucket.key || "（未标注）"}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{formatInt(bucket.requests)}</Td>
                    <Td className="text-right tabular-nums">{formatCompact(tokenTotal(bucket.tokens))}</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {formatUsdSpan(bucket.costLowUsd, bucket.costHighUsd)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="模型用量" subtitle="查看各模型的调用与记录成本" padded={false} className="min-w-0">
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
                      <Link href={`?model=${encodeURIComponent(bucket.key)}`} className="text-foreground hover:text-info">
                        {bucket.key || "（未标注）"}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{formatInt(bucket.requests)}</Td>
                    <Td className="text-right tabular-nums">{formatCompact(tokenTotal(bucket.tokens))}</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {formatUsdSpan(bucket.costLowUsd, bucket.costHighUsd)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>

      {shell.health ? (
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-subtle">
          <Badge tone={shell.health.pricing.status === "fresh" ? "ok" : "warn"}>
            pricing {shell.health.pricing.status}
          </Badge>
          <span className="min-w-0 break-words">
            运行 {Math.round(shell.health.uptimeMs / 1000)}s · OpenAI 兼容入口{" "}
            <code className="break-all text-muted-foreground">{shell.health.baseUrl}</code>
          </span>
        </div>
      ) : null}
    </>
  )
}
