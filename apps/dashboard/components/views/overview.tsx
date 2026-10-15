import { getI18n } from "@/lib/i18n/server"
import { CacheSavings } from "@/components/cache-metrics"
import Link from "next/link"
import { QuotasPanel } from "@/components/quotas-panel"
import { BudgetPill } from "@/components/budget-pill"
import { CostTrendChart } from "@/components/charts/cost-trend"
import { FilterPanel } from "@/components/filter-panel"
import { LiveRefresh } from "@/components/live-refresh"
import { Badge, Card, CardGrid, EmptyState, PageHeader, StatCard, TableWrap, Td, Th } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { costAccuracy, formatCompact, formatInt, formatMs, formatPercent, formatUsd, formatUsdSpan, tokenTotal } from "@/lib/format"
import { preserveFiltersQuery, toRouteHref, readFilters, resolveRange, usageQuery, type SearchParams } from "@/lib/range"
import { loadBuckets, loadShell, loadSummary, loadTrends } from "@/lib/server-data"

export interface ViewProps {
  params: SearchParams
  /** 嵌入模式：不含筛选面板，URL 区间由 embed 页面强制（默认近 7 天）。 */
  embedded?: boolean
}

export default async function OverviewView({ params, embedded }: ViewProps) {
  const { t } = await getI18n()

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
        title={t("s125")}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span> {t("s60")} <code className="text-foreground/80">{shell.health?.appId ?? "—"}</code></span>
            <span><span className="tabular-nums">{shell.health?.providers ?? "—"}</span> {t("s289")} </span>
            <span><span className="tabular-nums">{shell.health?.models ?? "—"}</span> {t("s290")} </span>
          </span>
        }
        actions={<LiveRefresh topics={["usage.recorded", "catalog.updated", "pricing.updated"]} ticker />}
      />

      {/* EVO-G09 A1: on first paint with a dead upstream the *first* block is this
          neutral guide; the red banner is demoted to a reaction to "重试". */}
      <UpstreamNotice message={upstreamErrors[0]} />
      <BudgetPill showAlert />
      {!embedded ? <QuotasPanel compact /> : null}

      {!embedded ? (
        <FilterPanel range={range} params={params} providers={shell.providers} models={shell.models} />
      ) : (
        <p className="mb-4 text-xs text-subtle"> {t("s250")} {t(range.label)}
          {filters.provider || filters.model ? t("s291") : ""}
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
          label={t("s292")}
          featured
          testId="overview-cost-span"
          value={costAccuracy(summaryData) === "unknown" && summaryData?.costHighUsd === 0 && hasUsage ? "—" : formatUsdSpan(summaryData?.costLowUsd, summaryData?.costHighUsd)}
          hint={
            summaryData
              ? <>
                  <Badge tone={costAccuracy(summaryData) === "unknown" ? "warn" : "muted"}>{t(`cost.${costAccuracy(summaryData)}`)}</Badge>
                  <span className="ml-2">
                    {costAccuracy(summaryData) === "unknown" && summaryData.costHighUsd === 0 && hasUsage
                      ? t("cost.noKnownAmount")
                      : t("s293", formatUsd(summaryData.costLowUsd), formatUsd(summaryData.costHighUsd))}
                  </span>
                </>
              : t("s294")
          }
        />
        <StatCard
          label={t("s295")}
          value={formatInt(summaryData?.requests)}
          hint={
            summaryData
              ? <>
                  {t("s296", formatInt(summaryData.successes), formatInt(summaryData.failures), formatPercent(summaryData.successRate))}
                  {summaryData.failures > 0 ? (
                    <Link href={toRouteHref("/logs", params, { status: "error" })} data-testid="overview-failures-drilldown" aria-label={t("drilldown.viewFailures")} className="ml-2 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                      {t("drilldown.viewFailures")}
                    </Link>
                  ) : null}
                </>
              : t("s294")
          }
          tone={summaryData && summaryData.failures > 0 ? "warn" : "neutral"}
        />
        <StatCard
          label={t("s297")}
          value={formatCompact(summaryData ? tokenTotal(summaryData.tokens) : undefined)}
          hint={
            summaryData
              ? t("s298", formatCompact(summaryData.tokens.input), formatCompact(summaryData.tokens.output))
              : t("s294")
          }
        />
      </CardGrid>

      {costAccuracy(summaryData) === "unknown" && hasUsage ? (
        <p data-testid="overview-cost-reconciliation" role="status" className="mt-3 rounded-lg border border-warning/35 bg-warning/10 p-3 text-sm text-warning">
          {t("cost.reconcile", formatInt(summaryData?.unpricedRequests), formatInt(summaryData?.unmeasuredRequests))}
        </p>
      ) : null}

      {!hasUsage && upstreamErrors.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title={t("s299")}
            description={t("s300")}
          />
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card
          title={t("s301", t(range.label))}
          subtitle={t("cost.bandNote")}
          className="min-w-0"
          actions={
            <Link
              href={toRouteHref("/trends", params)}
              data-testid="overview-trends-drilldown"
              aria-label={t("s303")}
              className="rounded-md px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            > {t("s303")} </Link>
          }
        >
          <CostTrendChart points={points} height={280} />
        </Card>
        <Card title={t("s304")} subtitle={t("s305")}>
          <dl className="divide-y divide-border/70">
            <CacheSavings micros={summaryData?.cacheSavingsMicros} label={t("cache.savings")} />
            <div data-testid="overview-local-cache-hit-rate" className="pb-5">
              <dt className="text-xs text-muted-foreground"> {t("cache.localHitRate")} </dt>
              <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-primary">
                {formatPercent(summaryData?.localCacheHitRate)}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-subtle">
                {summaryData ? t("cache.localHitDetail", formatInt(summaryData.localCacheHits), formatInt(summaryData.localCacheRequests)) : t("s294")}
              </dd>
            </div>
            <div className="pb-5">
              <dt className="text-xs text-muted-foreground"> {t("s306")} </dt>
              <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-primary">
                {formatPercent(summaryData?.cacheHitRate)}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-subtle">
                {summaryData ? t("s307", formatCompact(summaryData.tokens.cacheRead), formatCompact(summaryData.tokens.cacheWrite)) : t("s294")}
              </dd>
            </div>
            <div className="py-5">
              <dt className="text-xs text-muted-foreground"> {t("s308")} </dt>
              <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                {formatMs(summaryData?.avgLatencyMs)}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-subtle"> {t("s309")} </dd>
            </div>
            <div className="pt-5">
              <dt className="text-xs text-muted-foreground"> {t("s310")} </dt>
              <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                {formatMs(summaryData?.firstTokenMs)}
              </dd>
              <dd className="mt-1 text-xs leading-5 text-subtle"> {t("s311")} </dd>
            </div>
          </dl>
        </Card>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title={t("s312")} subtitle={t("s313")} padded={false} className="min-w-0">
          {providerBuckets.length === 0 ? (
            <div className="p-4">
              <EmptyState title={t("s314")} description={t("s315")} />
            </div>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th> {t("s87")} </Th>
                  <Th className="text-right"> {t("s316")} </Th>
                  <Th className="text-right">token</Th>
                  <Th className="text-right"> {t("s42")} </Th>
                </tr>
              </thead>
              <tbody>
                {providerBuckets.map((bucket) => (
                  <tr key={bucket.key}>
                    <Td>
                      <Link href={preserveFiltersQuery(params, { provider: bucket.key }) || "?"} data-testid="overview-provider-filter" aria-label={t("drilldown.filterItem", bucket.key)} className="text-foreground hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {bucket.key || t("s317")}
                      </Link>
                      <Link href={toRouteHref("/logs", params, { provider: bucket.key })} data-testid="overview-provider-logs" aria-label={t("drilldown.viewItemLogs", bucket.key)} className="ml-2 inline-block text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {t("drilldown.viewLogs")}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{formatInt(bucket.requests)}</Td>
                    <Td className="text-right tabular-nums">{formatCompact(tokenTotal(bucket.tokens))}</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {costAccuracy(summaryData) === "unknown" && bucket.costHighUsd === 0 && bucket.requests > 0 ? "—" : formatUsdSpan(bucket.costLowUsd, bucket.costHighUsd)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title={t("s318")} subtitle={t("s319")} padded={false} className="min-w-0">
          {modelBuckets.length === 0 ? (
            <div className="p-4">
              <EmptyState title={t("s320")} description={t("s321")} />
            </div>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th> {t("s177")} </Th>
                  <Th className="text-right"> {t("s316")} </Th>
                  <Th className="text-right">token</Th>
                  <Th className="text-right"> {t("s42")} </Th>
                </tr>
              </thead>
              <tbody>
                {modelBuckets.map((bucket) => (
                  <tr key={bucket.key}>
                    <Td>
                      <Link href={preserveFiltersQuery(params, { model: bucket.key }) || "?"} data-testid="overview-model-filter" aria-label={t("drilldown.filterItem", bucket.key)} className="text-foreground hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {bucket.key || t("s317")}
                      </Link>
                      <Link href={toRouteHref("/logs", params, { model: bucket.key })} data-testid="overview-model-logs" aria-label={t("drilldown.viewItemLogs", bucket.key)} className="ml-2 inline-block text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                        {t("drilldown.viewLogs")}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{formatInt(bucket.requests)}</Td>
                    <Td className="text-right tabular-nums">{formatCompact(tokenTotal(bucket.tokens))}</Td>
                    <Td className="whitespace-nowrap text-right tabular-nums">
                      {costAccuracy(summaryData) === "unknown" && bucket.costHighUsd === 0 && bucket.requests > 0 ? "—" : formatUsdSpan(bucket.costLowUsd, bucket.costHighUsd)}
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
            <span data-testid="overview-pricing-status">{t("pricing.label")} {t(shell.health.pricing.status === "fresh" ? "pricing.fresh" : shell.health.pricing.status === "stale" ? "pricing.stale" : shell.health.pricing.status === "error" ? "pricing.error" : "s160")}</span>
          </Badge>
          <span className="min-w-0 break-words"> {t("s322")} {Math.round(shell.health.uptimeMs / 1000)} {t("s323")} {" "}
            <code className="break-all text-muted-foreground">{shell.health.baseUrl}</code>
          </span>
        </div>
      ) : null}
    </>
  )
}
