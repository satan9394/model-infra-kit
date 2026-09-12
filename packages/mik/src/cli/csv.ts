import type { UsageEvent } from "../types.js"
import { sanitizeTagForDisplay, tagsToText } from "../usage/tags.js"
import { toMicroUsd } from "../store/money.js"

/**
 * The exported column order is a contract with the dashboard and with any host
 * that ingests the file, so it is defined once, here, and never reordered.
 *
 * EVO-G75 **appended** `tags` (the 15th column). EVO-G81 appends seven more
 * **traceability and reconciliation** columns after it. Appending is the only
 * compatible way to add a column: every pre-existing name keeps its position, so
 * a script reading by index or by header name is unaffected. `USAGE_CSV_FROZEN_COLUMNS`
 * is the literal 15-name prefix as it shipped in EVO-G75, and the G81 test
 * asserts it byte-for-byte.
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
  // EVO-G81 — appended, in this order:
  "request_id",
  "session_id",
  "first_token_ms",
  "is_streaming",
  "error_code",
  "pricing_model",
  "cost_microusd",
] as const

/** The columns as they were before EVO-G75 — the 14-name G75-era freeze. */
export const USAGE_CSV_LEGACY_COLUMNS = USAGE_CSV_COLUMNS.slice(0, 14) as readonly string[]

/**
 * The columns as they were before EVO-G81 — the 15-name prefix this card may
 * not touch (EVO-G81 acceptance: "前 15 列的列名与顺序逐字不变", asserted as a
 * literal in `test/export-reconcilable.test.ts`).
 */
export const USAGE_CSV_FROZEN_COLUMNS = USAGE_CSV_COLUMNS.slice(0, 15) as readonly string[]

export const USAGE_CSV_HEADER = USAGE_CSV_COLUMNS.join(",")

/** The frozen 15-name header as a literal-comparable string. */
export const USAGE_CSV_FROZEN_HEADER = USAGE_CSV_FROZEN_COLUMNS.join(",")

export const USAGE_CSV_HEADER_COUNT = USAGE_CSV_COLUMNS.length

/**
 * The characters that may not reach a CSV cell, and their escapes.
 *
 * A cell is host- or provider-supplied text (`app_id` from the host,
 * `model_actual` from the upstream response, `model`, `error_code`), and a
 * literal CR/LF inside a quoted cell makes **one record span several physical
 * lines** — the record unit every consumer uses (`wc -l`, `Get-Content`, a naive
 * `split("\n")`, a line-oriented importer). EVO-G82 fixed that for the `tags`
 * cell; EVO-G81 makes it a property of the **row** instead of one column, so no
 * future column can reintroduce it.
 *
 * The escape policy is `sanitizeTagForDisplay`'s, reused rather than
 * re-implemented: `\n`/`\r`/`\t` become their visible two-character escapes and
 * every other C0/C1 control becomes `?`. Reusing it keeps one implementation of
 * "a rendered value cannot change the line structure" (see `usage/tags.ts`).
 */
export function csvCellText(value: string): string {
  return sanitizeTagForDisplay(value)
}

/**
 * RFC 4180 quoting: only when a field contains a comma, quote or newline.
 *
 * After `csvCellText()` the newline branch is unreachable for text cells, so a
 * quoted cell can only be caused by a comma or a quote. It is kept because this
 * function is also the writer for values that are already known to be safe, and
 * because removing it would silently change the quoting of a cell containing a
 * comma.
 */
export function csvField(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return ""
  const text = typeof value === "number" ? String(value) : csvCellText(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Money is an **integer micro-USD** quantity (hard rule 2), and the export must
 * be reconcilable against `usage summary`, which aggregates the very same
 * integers (`SUM(CAST(ROUND(cost_usd * 1000000) AS INTEGER))`).
 *
 * Rendering four decimals per row was the audit's F4: 0.00034 + 0.00018 + 0.00013
 * printed as 0.0003 + 0.0002 + 0.0001 = 0.0006 while the total printed 0.0007, so
 * "add up the rows" could never agree with "read the total". Six decimals is
 * exactly the micro-USD unit, so the sum of the printed values **is** the total's
 * integer; the `cost_microusd` column carries the same number as an integer for
 * callers that would rather not re-parse a decimal. The decision (EVO-G81) is
 * therefore: **the reconciliation precision of the CSV is micro-USD (1e-6)**, and
 * at the human four-decimal display precision the rounded row sum equals the
 * displayed total.
 */
export function csvMoney(micro: number): string {
  if (!Number.isFinite(micro)) return "0.000000"
  const value = micro === 0 ? 0 : micro / 1_000_000
  return value.toFixed(6)
}

/** One event's integer micro-USD, the unit every money figure sums in. */
function eventMicros(event: UsageEvent): number {
  return toMicroUsd(event.cost.usd)
}

/**
 * `true`/`false` as text rather than `1`/`0`: the column is documented as a
 * boolean and the rest of this file writes text. Empty when the field is absent
 * on an event built by hand, so a missing value stays distinguishable from
 * `false` the way every other optional column works.
 */
function csvBool(value: boolean | undefined): string {
  if (value === undefined || value === null) return ""
  return value ? "true" : "false"
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
    csvMoney(eventMicros(event)),
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
    // `redactDeep`) and, since EVO-G82, also neutralises control characters
    // (`sanitizeTagForDisplay`). That is not belt-and-braces: a row written
    // before EVO-G75 stored its tags unredacted, and this card opened a CSV
    // column for them — so the column must not be the path that prints a
    // plaintext token or a line break. Redacting here covers those rows without
    // rewriting a stored byte and without a migration.
    csvField(tagsToText(event.tags)),
    // EVO-G81 — traceability. `request_id` is the identity every other read
    // surface uses (`usage_events.request_id`, `GET /api/usage/logs/:id`,
    // `UsageEvent.requestId`), so one CSV row can be located again; an idempotent
    // writer can be keyed on it. The rest is the context a reconciliation is
    // usually missing: which session, whether the call streamed, how long the
    // first token took, and why a failed call failed.
    csvField(event.requestId),
    csvField(event.sessionId),
    csvField(event.firstTokenMs),
    csvField(csvBool(event.isStreaming)),
    csvField(event.errorCode),
    csvField(event.pricingModel),
    csvField(eventMicros(event)),
  ].join(",")
}

/** Header plus one row per event, oldest first, with a trailing newline. */
export function usageCsv(events: readonly UsageEvent[]): string {
  const ordered = [...events].sort((a, b) => a.ts - b.ts)
  return [USAGE_CSV_HEADER, ...ordered.map(usageCsvRow)].join("\n") + "\n"
}
