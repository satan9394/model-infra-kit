import type { UsageEvent } from "../types.js"

/**
 * The exported column order is a contract with the dashboard and with any host
 * that ingests the file, so it is defined once, here, and never reordered.
 */
export const USAGE_CSV_COLUMNS = [
  "ts",
  "app_id",
  "provider",
  "model",
  "status",
  "input",
  "output",
  "cache_read",
  "cache_write",
  "reasoning",
  "cost_usd",
  "pricing_source",
  "pricing_basis",
  "latency_ms",
] as const

export const USAGE_CSV_HEADER = USAGE_CSV_COLUMNS.join(",")

/** RFC 4180 quoting: only when a field contains a comma, quote or newline. */
export function csvField(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return ""
  const text = typeof value === "number" ? String(value) : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Money keeps the CLI's four-decimal rule; token columns stay raw integers. */
function csvMoney(usd: number | undefined): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "0.0000"
  return (Math.abs(usd) < 0.00005 ? 0 : usd).toFixed(4)
}

export function usageCsvRow(event: UsageEvent): string {
  return [
    csvField(new Date(event.ts).toISOString()),
    csvField(event.appId),
    csvField(event.providerId),
    csvField(event.modelActual),
    csvField(event.status),
    csvField(event.usage.input),
    csvField(event.usage.output),
    csvField(event.usage.cacheRead),
    csvField(event.usage.cacheWrite),
    csvField(event.usage.reasoning),
    csvMoney(event.cost.usd),
    csvField(event.cost.source),
    csvField(event.cost.basis),
    csvField(event.latencyMs),
  ].join(",")
}

/** Header plus one row per event, oldest first, with a trailing newline. */
export function usageCsv(events: readonly UsageEvent[]): string {
  const ordered = [...events].sort((a, b) => a.ts - b.ts)
  return [USAGE_CSV_HEADER, ...ordered.map(usageCsvRow)].join("\n") + "\n"
}
