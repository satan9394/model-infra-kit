/** Presentation helpers. Pure functions, safe in both server and client code. */

export function formatUsd(value: number | undefined | null, digits = 4): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (value === 0) return "$0"
  if (Math.abs(value) < 0.0001) return "<$0.0001"
  const fixed = value.toFixed(digits)
  // Trim the noise a fixed-point rendering adds, keeping at least two decimals.
  const trimmed = fixed.replace(/(\.\d{2}\d*?)0+$/, "$1")
  return `$${trimmed}`
}

export function formatInt(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  return Math.round(value).toLocaleString("en-US")
}

export function formatCompact(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}K`
  return formatInt(value)
}

export function formatPercent(ratio: number | undefined | null, digits = 1): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "—"
  // The API reports 0..1 ratios; some fields are already percentages.
  const value = ratio <= 1 ? ratio * 100 : ratio
  return `${value.toFixed(digits)}%`
}

export function formatMs(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`
  return `${Math.round(value)}ms`
}

export function formatDateTime(ts: number | undefined | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "—"
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return "—"
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatDay(value: string | undefined | null): string {
  if (!value) return "—"
  // `YYYY-MM-DD` (localtime, as the API reports it) → `MM-DD` for axis ticks.
  return value.length >= 10 ? value.slice(5, 10) : value
}

export function formatRelative(ts: number | undefined | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "—"
  const delta = Date.now() - ts
  if (delta < 0) return "刚刚"
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))} 秒前`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`
  return formatDateTime(ts)
}

export function truncate(value: string | undefined | null, max = 40): string {
  if (!value) return "—"
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** USD per 1M tokens → `$x.xx` with the trailing zeros the price table needs. */
export function formatRate(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  if (value === 0) return "$0"
  return `$${value.toFixed(value < 1 ? 3 : 2)}`
}

export function tokenTotal(tokens: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning
}
