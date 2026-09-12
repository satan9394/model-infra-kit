import type { UsageEvent } from "../types.js"
import { tagsToText } from "../usage/tags.js"

/**
 * The exported column order is a contract with the dashboard and with any host
 * that ingests the file, so it is defined once, here, and never reordered.
 *
 * EVO-G75 **appends** `tags` at the end. Appending is the only compatible way to
 * add a column: every pre-existing name keeps its position, so a script reading
 * by index or by header name is unaffected. The G75 test asserts the first
 * fourteen names are byte-identical to the pre-change list.
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
  "tags",
] as const

/** The columns as they were before EVO-G75 — the frozen part of the contract. */
export const USAGE_CSV_LEGACY_COLUMNS = USAGE_CSV_COLUMNS.slice(0, 14) as readonly string[]

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
    // EVO-G75: the host's attribution tags as stable `key=value` pairs, with the
    // machine-written keys left out: `_mik_`-prefixed ones and the EVO-G73
    // reconciliation keys (`provider_cost_raw` / `provider_cost_status`, which
    // are **unprefixed** — see `RESERVED_TAG_KEYS`). They stay readable through
    // `UsageEvent.tags` and the API.
    //
    // `tagsToText` redacts **at render time** (`redactTagsForDisplay` →
    // `redactDeep`). That is not belt-and-braces: a row written before EVO-G75
    // stored its tags unredacted, and this card is the one that opened a CSV
    // column for them — so the column must not be the path that prints a
    // plaintext token. Redacting here covers those rows without rewriting a
    // stored byte and without a migration.
    csvField(tagsToText(event.tags)),
  ].join(",")
}

/** Header plus one row per event, oldest first, with a trailing newline. */
export function usageCsv(events: readonly UsageEvent[]): string {
  const ordered = [...events].sort((a, b) => a.ts - b.ts)
  return [USAGE_CSV_HEADER, ...ordered.map(usageCsvRow)].join("\n") + "\n"
}
