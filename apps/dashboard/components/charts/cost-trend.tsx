"use client"

import { useI18n } from "@/lib/i18n/provider"

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { formatDay, formatUsd } from "@/lib/format"
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

/** Daily recorded point estimate over the selected window. */
export function CostTrendChart({ points, height = 280 }: { points: UsageTrendPoint[]; height?: number }) {
  const { t } = useI18n()

  if (points.length === 0) {
    return (
      <EmptyState
        title={t("s37")}
        description={t("s38")}
      />
    )
  }

  const data = points.map((point) => ({ ...point, label: formatDay(point.date) }))

  return (
    <div className="min-w-0 text-xs" style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 14, right: 16, bottom: 0, left: 0 }} accessibilityLayer>
          <defs>
            <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-chart-cost)" stopOpacity={0.16} />
              <stop offset="100%" stopColor="var(--color-chart-cost)" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-chart-grid)" strokeDasharray="3 5" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--color-chart-axis)", fontSize: 11 }}
            tickMargin={12}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(value: unknown) => formatUsd(Number(value), 2)}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--color-chart-axis)", fontSize: 11 }}
            tickMargin={8}
            width={64}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: "var(--color-chart-axis)" }}
            formatter={(value: unknown) => [formatUsd(Number(value)), t("s39")]}
            labelFormatter={(label: unknown) => String(label)}
            cursor={{ stroke: "var(--color-chart-cost)", strokeDasharray: "3 5", strokeOpacity: 0.4 }}
          />
          <Area
            type="monotone"
            dataKey="costUsd"
            name={t("s39")}
            stroke="var(--color-chart-cost)"
            strokeWidth={2.5}
            fill="url(#costFill)"
            activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
