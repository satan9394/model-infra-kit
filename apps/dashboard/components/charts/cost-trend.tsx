"use client"

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { formatDay, formatUsd } from "@/lib/format"
import type { UsageTrendPoint } from "@/lib/types"
import { EmptyState } from "@/components/ui"

const TOOLTIP_STYLE = {
  backgroundColor: "#0d1424",
  border: "1px solid #1e293b",
  borderRadius: 8,
  fontSize: 12,
  color: "#e2e8f0",
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
              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "#1e293b" }} minTickGap={16} />
          <YAxis
            tickFormatter={(value: unknown) => formatUsd(Number(value), 2)}
            tickLine={false}
            axisLine={{ stroke: "#1e293b" }}
            width={70}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: "#94a3b8" }}
            formatter={(value: unknown) => [formatUsd(Number(value)), "成本"]}
            labelFormatter={(label: unknown) => String(label)}
          />
          <Area type="monotone" dataKey="costUsd" name="成本" stroke="#38bdf8" strokeWidth={2} fill="url(#costFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
