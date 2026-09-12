/**
 * Human-readable output helpers for the `mik` CLI.
 *
 * Three rules are load-bearing here and are enforced by the card's acceptance
 * criteria: catalogue money is always four decimals, usage money is rendered at
 * the micro-USD the totals really have (EVO-G85), and token counts always carry
 * thousands separators.
 */

/** Fixed four-decimal USD, so a cost column never changes width. */
export function formatMoney(usd: number | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "n/a"
  // Avoid "-0.0000" for a tiny negative rounding to zero.
  const value = Math.abs(usd) < 0.00005 ? 0 : usd
  return value.toFixed(4)
}

/**
 * Money as the **usage surfaces** print it — `usage summary`, `logs`, `trends`
 * and `--by-tag` (EVO-G85).
 *
 * The job here is reconciliation, not column width. Every amount these surfaces
 * show is a sum of **integer micro-USD** (hard rule 2) and `usage export`
 * renders those same integers at six decimals, so an amount whose micro total
 * has nothing below 1e-4 is printed at four decimals exactly as it always was,
 * while a remainder is printed at six — the micro-USD unit itself. The audit's
 * F4 shape then reads `0.000654` on both surfaces: the reader adds the exported
 * column and compares digits, with no display-rounding rule in between. EVO-G81
 * left these surfaces at four decimals, and that is precisely why the two
 * figures only agreed *after* the reader rounded one of them.
 *
 * The zero clamp is half a **micro**, not half of 1e-4 (as `formatMoney` uses):
 * a total of 30 µ$ is a real amount, and printing it `0.0000` is the same
 * disagreement in miniature. Catalogue prices (`mik models`, `mik pricing`) keep
 * `formatMoney`: they are dollars per million tokens, not reconciliation
 * targets, and the localized help text promises four decimals for them.
 */
export function formatUsageMoney(usd: number | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "n/a"
  const micros = Math.round(usd * 1_000_000)
  // Avoid "-0.0000" for a negative that is zero micro-USD.
  if (micros === 0) return "0.0000"
  return (micros / 1_000_000).toFixed(micros % 100 === 0 ? 4 : 6)
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

/**
 * Terminal columns a string occupies, for the East Asian Wide/Fullwidth ranges.
 *
 * Purely ASCII text is unaffected (`displayWidth("A") === "A".length`), so every
 * English table keeps rendering byte-for-byte as before; the point is that a
 * localized (EVO-G13) Chinese header such as `供应商` is padded as 6 columns
 * instead of 3, which is what stops it from shifting the column it labels.
 */
function displayWidth(value: string): number {
  let width = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    width += isWide(code) ? 2 : 1
  }
  return width
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** Pad `value` to `width` display columns in the requested direction. */
function cell(value: string, width: number, align: Align): string {
  const padding = " ".repeat(Math.max(0, width - displayWidth(value)))
  return align === "right" ? padding + value : value + padding
}

/**
 * A plain space-aligned table. Deliberately dependency-free: the CLI must stay
 * on Node built-ins only.
 */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[], align?: readonly Align[]): string {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ""))),
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
  const width = Math.max(0, ...entries.map(([label]) => displayWidth(label)))
  return entries.map(([label, value]) => `${cell(label, width, "left")}  ${value}`).join("\n")
}
