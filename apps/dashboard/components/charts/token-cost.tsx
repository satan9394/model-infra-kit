"use client"

import { useI18n } from "@/lib/i18n/provider"

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { formatCompact, formatDay, formatUsd } from "@/lib/format"
import type { UsageTrendPoint } from "@/lib/types"
import { EmptyState } from "@/components/ui"

const TOOLTIP_STYLE = {
  backgroundColor: "var(--color-tooltip)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  fontSize: 12,
  color: "var(--color-foreground)",
  boxShadow: "0 12px 32px var(--color-shadow)",
} as const

const SERIES = [
  { key: "input", label: "input", color: "var(--color-chart-input)" },
  { key: "output", label: "output", color: "var(--color-chart-output)" },
  { key: "cacheRead", label: "cache_read", color: "var(--color-chart-cache-read)" },
  { key: "cacheWrite", label: "cache_write", color: "var(--color-chart-cache-write)" },
] as const

/**
 * Token mix per day (stacked areas, left axis) with cost as a line on the
 * right axis, so a cheap day with a large token count stays visible.
 */
export function TokenCostChart({ points, height = 340 }: { points: UsageTrendPoint[]; height?: number }) {
  const { t } = useI18n()

  if (points.length === 0) {
    return (
      <EmptyState
        title={t("s40")}
        description={t("s41")}
      />
    )
  }

  const data = points.map((point) => ({
    label: formatDay(point.date),
    date: point.date,
    input: point.tokens.input,
    output: point.tokens.output,
    cacheRead: point.tokens.cacheRead,
    cacheWrite: point.tokens.cacheWrite,
    costUsd: point.costUsd,
  }))

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-chart-grid)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--color-chart-grid)" }} minTickGap={16} />
          <YAxis
            yAxisId="tokens"
            tickFormatter={(value: unknown) => formatCompact(Number(value))}
            tickLine={false}
            axisLine={{ stroke: "var(--color-chart-grid)" }}
            width={64}
          />
          <YAxis
            yAxisId="cost"
            orientation="right"
            tickFormatter={(value: unknown) => formatUsd(Number(value), 2)}
            tickLine={false}
            axisLine={{ stroke: "var(--color-chart-grid)" }}
            width={70}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: "var(--color-chart-axis)" }}
            formatter={(value: unknown, name: unknown) =>
              name === t("s42") ? [formatUsd(Number(value)), t("s42")] : [formatCompact(Number(value)), String(name)]
            }
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--color-chart-axis)" }} />
          {SERIES.map((series) => (
            <Area
              key={series.key}
              yAxisId="tokens"
              type="monotone"
              dataKey={series.key}
              name={series.label}
              stackId="tokens"
              stroke={series.color}
              fill={series.color}
              fillOpacity={0.28}
              strokeWidth={1.5}
            />
          ))}
          <Line yAxisId="cost" type="monotone" dataKey="costUsd" name={t("s42")} stroke="var(--color-chart-cost)" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
