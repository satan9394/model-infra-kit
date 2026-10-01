import { getI18n } from "@/lib/i18n/server"
import { TokenCostChart } from "@/components/charts/token-cost"
import { FilterPanel } from "@/components/filter-panel"
import { LiveRefresh } from "@/components/live-refresh"
import { Card, EmptyState, PageHeader, StatCard, TableWrap, Td, Th } from "@/components/ui"
import { UpstreamNotice } from "@/components/upstream-notice"
import { formatCompact, formatInt, formatUsdSpan, tokenTotal } from "@/lib/format"
import { readFilters, resolveRange, usageQuery, type SearchParams } from "@/lib/range"
import { loadShell, loadSummary, loadTrends } from "@/lib/server-data"

export interface ViewProps {
  params: SearchParams
  embedded?: boolean
}

export default async function TrendsView({ params, embedded }: ViewProps) {
  const { t } = await getI18n()

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
  // "Most expensive" means the highest recorded floor; use the upper endpoint
  // only to break ties, so a point estimate never decides the selected day.
  const busiest = points.reduce<{ date: string; costLowUsd: number; costHighUsd: number } | null>(
    (best, point) =>
      best === null ||
      point.costLowUsd > best.costLowUsd ||
      (point.costLowUsd === best.costLowUsd && point.costHighUsd > best.costHighUsd)
        ? { date: point.date, costLowUsd: point.costLowUsd, costHighUsd: point.costHighUsd }
        : best,
    null,
  )

  return (
    <>
      <PageHeader
        title={t("s127")}
        description={t("s353")}
        actions={<LiveRefresh topics={["usage.recorded"]} />}
      />

      {/* EVO-G09 A1: neutral guide first, error banner only after a failed retry. */}
      <UpstreamNotice message={errors[0]} />

      {!embedded ? (
        <FilterPanel range={range} params={params} providers={shell.providers} models={shell.models} />
      ) : (
        <p className="mb-4 text-xs text-subtle"> {t("s250")} {t(range.label)}</p>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t("s354")} value={formatCompact(totals ? tokenTotal(totals.tokens) : undefined)} hint={t("s355", points.length)} />
        {/* EVO-G89: the recorded band, never the deprecated point estimate
            `costUsd` (unpriced and folded requests contribute 0 to all three, so
            the point bounds nothing). Identical while the band is a point.
            EVO-G91: `testId` is the hook the DASH check in `scripts/e2e/run.mjs`
            anchors on — the overview tile and this one print the same window, so
            a page-wide `includes` could not say which cell it read, and while
            every row is point-priced neither tile's string can distinguish the
            band from the point estimate. Same mechanism as `overview-cost-span`;
            the id is distinct so the cross-check between the two tiles is real. */}
        <StatCard
          label={t("s356")}
          testId="trends-cost-span"
          value={formatUsdSpan(totals?.costLowUsd, totals?.costHighUsd)}
          hint={t("s357")}
        />
        <StatCard
          label={t("s358")}
          value={busiest ? formatUsdSpan(busiest.costLowUsd, busiest.costHighUsd) : "—"}
          hint={busiest ? busiest.date : t("s359")}
        />
        <StatCard label={t("s295")} value={formatInt(totals?.requests)} hint={t("s360")} />
      </div>

      <Card title={t("s361", t(range.label))} subtitle="GET /api/usage/trends?bucket=day">
        <TokenCostChart points={points} />
      </Card>

      <div className="mt-4">
        <Card title={t("s362")} subtitle={t("s363")} padded={false}>
          {points.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={t("s40")}
                description={t("s364")}
              />
            </div>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th> {t("s365")} </Th>
                  <Th className="text-right"> {t("s316")} </Th>
                  <Th className="text-right">input</Th>
                  <Th className="text-right">output</Th>
                  <Th className="text-right">cache_read</Th>
                  <Th className="text-right">cache_write</Th>
                  <Th className="text-right"> {t("s42")} </Th>
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
                    <Td className="text-right font-mono tabular-nums">
                      {formatUsdSpan(point.costLowUsd, point.costHighUsd)}
                    </Td>
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
