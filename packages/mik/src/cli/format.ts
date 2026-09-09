/**
 * Human-readable output helpers for the `mik` CLI.
 *
 * Two rules are load-bearing here and are enforced by the card's acceptance
 * criteria: money is always four decimals, and token counts always carry
 * thousands separators.
 */

/** Fixed four-decimal USD, so a cost column never changes width. */
export function formatMoney(usd: number | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "n/a"
  // Avoid "-0.0000" for a tiny negative rounding to zero.
  const value = Math.abs(usd) < 0.00005 ? 0 : usd
  return value.toFixed(4)
}

/** Integer count with thousands separators, e.g. `1,234,567`. */
export function formatTokens(tokens: number | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return "0"
  const rounded = Math.round(tokens)
  const sign = rounded < 0 ? "-" : ""
  return sign + Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** A 0..1 ratio as a percentage with one decimal. */
export function formatPercent(ratio: number | undefined): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "n/a"
  return `${(ratio * 100).toFixed(1)}%`
}

/** Milliseconds below one second, seconds above. */
export function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-"
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/** Local `YYYY-MM-DD HH:mm:ss`. */
export function formatTimestamp(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "-"
  const date = new Date(ts)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** Local `YYYY-MM-DD`. */
export function formatDate(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "-"
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export type Align = "left" | "right"

function cell(value: string, width: number, align: Align): string {
  return align === "right" ? value.padStart(width) : value.padEnd(width)
}

/**
 * A plain space-aligned table. Deliberately dependency-free: the CLI must stay
 * on Node built-ins only.
 */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[], align?: readonly Align[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  )
  const render = (cells: readonly string[]): string =>
    headers
      .map((_, index) => cell(cells[index] ?? "", widths[index] ?? 0, align?.[index] ?? "left"))
      .join("  ")
      .replace(/\s+$/, "")
  const separator = widths.map((width) => "-".repeat(width)).join("  ")
  return [render(headers), separator, ...rows.map(render)].join("\n")
}

/** A two-column `label  value` block, used by `usage summary`. */
export function formatKeyValues(entries: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(0, ...entries.map(([label]) => label.length))
  return entries.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n")
}
