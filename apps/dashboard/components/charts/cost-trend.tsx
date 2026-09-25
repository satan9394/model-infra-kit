"use client"

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

/** Daily cost over the selected window. */
export function CostTrendChart({ points, height = 260 }: { points: UsageTrendPoint[]; height?: number }) {
  if (points.length === 0) {
    return (
      <EmptyState
        title="该区间没有成本数据"
        description="先产生一次调用（或运行 seed 脚本写入假数据），这里就会出现按天的成本曲线。"
      />
    )
  }

  const data = points.map((point) => ({ ...point, label: formatDay(point.date) }))

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-chart-cost)" stopOpacity={0.34} />
              <stop offset="100%" stopColor="var(--color-chart-cost)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-chart-grid)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--color-chart-grid)" }} minTickGap={16} />
          <YAxis
            tickFormatter={(value: unknown) => formatUsd(Number(value), 2)}
            tickLine={false}
            axisLine={{ stroke: "var(--color-chart-grid)" }}
            width={70}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: "var(--color-chart-axis)" }}
            formatter={(value: unknown) => [formatUsd(Number(value)), "成本"]}
            labelFormatter={(label: unknown) => String(label)}
          />
          <Area type="monotone" dataKey="costUsd" name="成本" stroke="var(--color-chart-cost)" strokeWidth={2} fill="url(#costFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
