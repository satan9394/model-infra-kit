/**
 * Date-range and filter handling for the query string.
 *
 * `mik serve` buckets daily rows with `strftime(..., 'localtime')`, so the
 * boundaries here are local-time too: a "today" window and the first bar of the
 * trend chart describe the same days.
 *
 * Pure functions — imported by both server pages and client filter controls.
 */

export type RangePreset = "today" | "7d" | "30d" | "custom"

export const RANGE_PRESETS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "today", label: "今日" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义" },
]

export interface ResolvedRange {
  preset: RangePreset
  /** Inclusive lower bound, epoch ms (local midnight for day presets). */
  from: number
  /** Inclusive upper bound, epoch ms. */
  to: number
  /** `YYYY-MM-DD` for `<input type="date">`. */
  fromInput: string
  toInput: string
  label: string
}

export type SearchParams = Record<string, string | string[] | undefined>

const DAY_MS = 86_400_000

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

/** `YYYY-MM-DD` of a local-time timestamp. */
export function toDateInput(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `YYYY-MM-DD` (local midnight) → epoch ms; `null` when unparsable. */
export function parseDateInput(value: string | undefined): number | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

function presetLabel(preset: RangePreset, range: ResolvedRange): string {
  switch (preset) {
    case "today":
      return "今日"
    case "7d":
      return "近 7 天"
    case "30d":
      return "近 30 天"
    default:
      return `${range.fromInput} ~ ${range.toInput}`
  }
}

/** Resolve the window described by the query string. Never throws. */
export function resolveRange(params: SearchParams, now = Date.now()): ResolvedRange {
  const raw = first(params.range)
  const preset: RangePreset =
    raw === "today" || raw === "7d" || raw === "30d" || raw === "custom"
      ? raw
      : // A custom from/to without an explicit preset is still a custom window.
        first(params.from) || first(params.to)
        ? "custom"
        : "30d"

  const todayStart = startOfLocalDay(now)
  let from: number
  let to: number

  if (preset === "today") {
    from = todayStart
    to = now
  } else if (preset === "7d") {
    from = todayStart - 6 * DAY_MS
    to = now
  } else if (preset === "30d") {
    from = todayStart - 29 * DAY_MS
    to = now
  } else {
    const parsedFrom = parseDateInput(first(params.from))
    const parsedTo = parseDateInput(first(params.to))
    const fallbackTo = toDateInput(now)
    const start = parsedFrom ?? startOfLocalDay(now) - 29 * DAY_MS
    // An end date is inclusive: it covers the whole local day.
    const endDay = parsedTo ?? startOfLocalDay(now)
    to = Math.min(endDay + DAY_MS - 1, now)
    from = Math.min(start, to)
  }

  const range: ResolvedRange = {
    preset,
    from,
    to,
    fromInput: toDateInput(from),
    toInput: toDateInput(to),
    label: "",
  }
  range.label = presetLabel(preset, range)
  return range
}

export interface UsageFilters {
  provider?: string
  model?: string
  status?: "ok" | "error"
  limit?: number
  offset?: number
}

export function readFilters(params: SearchParams): UsageFilters {
  const filters: UsageFilters = {}
  const provider = first(params.provider)?.trim()
  const model = first(params.model)?.trim()
  const status = first(params.status)?.trim()
  const limit = Number(first(params.limit))
  const offset = Number(first(params.offset))
  if (provider) filters.provider = provider
  if (model) filters.model = model
  if (status === "ok" || status === "error") filters.status = status
  if (Number.isInteger(limit) && limit > 0 && limit <= 500) filters.limit = limit
  if (Number.isInteger(offset) && offset >= 0) filters.offset = offset
  return filters
}

/** Query string for the `/api/usage/*` endpoints. */
export function usageQuery(range: ResolvedRange, filters: UsageFilters = {}): string {
  const search = new URLSearchParams()
  search.set("from", String(Math.floor(range.from)))
  search.set("to", String(Math.floor(range.to)))
  if (filters.provider) search.set("provider", filters.provider)
  if (filters.model) search.set("model", filters.model)
  if (filters.status) search.set("status", filters.status)
  if (filters.limit !== undefined) search.set("limit", String(filters.limit))
  if (filters.offset !== undefined) search.set("offset", String(filters.offset))
  return search.toString()
}

/** Preserve the current filters while replacing the window. */
export function withRange(params: SearchParams, patch: Partial<{ range: RangePreset; from: string; to: string }>): string {
  const search = new URLSearchParams()
  for (const key of ["provider", "model", "status", "limit"]) {
    const value = first(params[key])
    if (value) search.set(key, value)
  }
  if (patch.range) search.set("range", patch.range)
  if (patch.from) search.set("from", patch.from)
  if (patch.to) search.set("to", patch.to)
  const query = search.toString()
  return query ? `?${query}` : ""
}

/** `?range=...` (plus `from`/`to` for a custom window) to link between pages. */
export function rangeQueryString(range: ResolvedRange): string {
  const search = new URLSearchParams()
  search.set("range", range.preset)
  if (range.preset === "custom") {
    search.set("from", range.fromInput)
    search.set("to", range.toInput)
  }
  return `?${search.toString()}`
}

/** `?a=b` from a plain record, dropping empty values. */
export function toQueryString(values: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `?${query}` : ""
}
