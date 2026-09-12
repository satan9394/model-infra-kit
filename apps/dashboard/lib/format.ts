/** Presentation helpers. Pure functions, safe in both server and client code. */

/**
 * USD for the dashboard's cost surfaces.
 *
 * `digits` is the caller's own precision **when it names one** — the chart axes
 * ask for two, the log detail panel for six. The default follows the CLI's usage
 * money convention (`formatUsageMoney`, EVO-G85/G88): every amount comes from
 * integer micro-USD, so a value with nothing below 1e-4 keeps the four decimals
 * it always had, while a remainder is rendered at six — the micro unit itself.
 * Before this the same charge read `0.000654` in `mik usage summary` and
 * `$0.0007` here, which is one number the reader cannot reconcile.
 *
 * The clamp is half a **micro**, not 1e-4: 30 µ$ is a real amount and used to be
 * printed `<0.0001`, i.e. "smaller than the smallest thing you can see" for a
 * value the CLI shows exactly (R257 — the threshold, not just the digit count).
 * The dashboard keeps its own `$` and trailing-zero trimming; the *rule* is what
 * is shared with the CLI, not the literal string.
 */
export function formatUsd(value: number | undefined | null, digits?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—"
  const micros = Math.round(value * 1_000_000)
  // Also covers `-0` from a tiny negative: there is no "-$0".
  if (micros === 0) return "$0"
  const places = digits ?? (micros % 100 === 0 ? 4 : 6)
  const fixed = (micros / 1_000_000).toFixed(places)
  // Trim the noise a fixed-point rendering adds, keeping at least two decimals.
  const trimmed = fixed.replace(/(\.\d{2}\d*?)0+$/, "$1")
  return `$${trimmed}`
}

/**
 * A *recorded* cost as one cell, from the two endpoints of its band (EVO-G89).
 *
 * The overview's headline and the trends section total used to render
 * `UsageSummary.costUsd` — the point estimate, and the one member of
 * `costLowUsd ≤ costUsd ≤ costHighUsd` that is an endpoint of nothing. The CLI's
 * `usage summary` stopped reading it in the same card; a product that tells its
 * hosts not to read a field must not read it itself, and the two surfaces must
 * keep one money rule (EVO-G88).
 *
 * Point-priced sources (`manual` / `flat` / provider-reported) record
 * `low === high`, so that case renders exactly the string it always did. A band
 * renders `a ~ b` — the same shape the interval hint below it already uses, so
 * the cell and the hint can never contradict each other. Nothing is
 * interpolated: both ends are recorded amounts, and a missing value stays the
 * dashboard's `—` rather than becoming half of a range.
 */
export function formatUsdSpan(low: number | undefined | null, high: number | undefined | null): string {
  const floor = formatUsd(low)
  if (typeof low !== "number" || typeof high !== "number" || !Number.isFinite(low) || !Number.isFinite(high)) {
    return floor
  }
  return low === high ? floor : `${floor} ~ ${formatUsd(high)}`
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
