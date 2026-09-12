import { PROVIDER_COST_RAW_TAG, PROVIDER_COST_STATUS_TAG } from "../pricing/reported-cost.js"
import { redact, redactDeep } from "../util/redact.js"

/**
 * Host-defined attribution tags (EVO-G75).
 *
 * A host runs many business features through one model layer. It labels each
 * call with its own strings (`{ feature: "quant-backtest", sessionId: "…" }`)
 * and this module turns them into a **cost dimension** — nothing more. Tags are
 * never identities: no permission, quota or access control reads them.
 *
 * Two invariants live here, and both are load-bearing:
 *
 * 1. **A tag can never break a host call** (AGENTS rule 6). The input is
 *    `unknown` on purpose: a host may hand over a number, `null`, a nested
 *    object or a 10 MB string, and metering must still succeed. Every malformed
 *    value is coerced by a fixed, documented policy instead of throwing.
 * 2. **A tag is redacted before it is stored** (rule 4's extension). Tags reach
 *    the SQLite file and the CSV export, and a host is very likely to
 *    accidentally put a token in one ("api_key": "sk-live-…"). Sanitising
 *    therefore ends in `redactDeep`, not in a raw copy.
 */

/**
 * Where a tag value stops being useful and starts being a payload. Counting by
 * code points (`Array.from`) so a 256-emoji value is treated like any other
 * 256-character one.
 */
export const MAX_TAG_VALUE_LENGTH = 256

/**
 * A key longer than this is dropped rather than truncated: two distinct long
 * keys truncating to the same prefix would silently merge two cost buckets.
 */
export const MAX_TAG_KEY_LENGTH = 64

/** Upper bound on `JSON.stringify` of a non-string value before it is cut. */
const MAX_TAG_JSON_LENGTH = 512

/**
 * Key namespace reserved for machine-written diagnostics.
 *
 * **This prefix is a convention of this module and nothing writes it yet.** The
 * keys that actually exist on `usage_events.tags_json` today are EVO-G73's
 * reconciliation tags, and they are **not** prefixed (see `RESERVED_TAG_KEYS`).
 * The prefix is kept as a forward guard for future machine keys, but it is
 * never the whole predicate — an earlier revision of this file used the prefix
 * alone, which excluded nothing at all.
 */
export const RESERVED_TAG_PREFIX = "_mik_"

/**
 * The machine-written keys that exist **today**, taken from their owner
 * (`pricing/reported-cost.ts`) rather than re-typed here.
 *
 * `provider_cost_raw` is per-call noise (the raw amount text of one call) and
 * `provider_cost_status` is `"accepted"` or `"rejected: <reason>"` — neither is
 * host attribution, and a breakdown that listed them would answer "which
 * feature is burning money" with one bucket per call.
 *
 * They stay **stored** in `usage_events.tags_json` and are still returned by
 * `UsageEvent.tags` (EVO-G73 reconciliation reads them there, and from the HTTP
 * responses, which redact values but never drop a key). What they never do is
 * appear in the **rendered attribution surfaces**: `byTag()` and
 * `usage summary --by-tag` exclude them, and `usage export`'s `tags` column is
 * rendered through `redactTagsForDisplay()`, which drops them too.
 */
export const RESERVED_TAG_KEYS: readonly string[] = [PROVIDER_COST_RAW_TAG, PROVIDER_COST_STATUS_TAG]

/** Whether a key is machine-written reconciliation data rather than attribution. */
export function isReservedTagKey(key: string): boolean {
  return key.startsWith(RESERVED_TAG_PREFIX) || RESERVED_TAG_KEYS.includes(key)
}

/** Cut a string to `max` code points, leaving shorter strings alone. */
function cap(value: string, max: number): string {
  const points = Array.from(value)
  return points.length <= max ? value : points.slice(0, max).join("")
}

/**
 * Turn one arbitrary value into a tag string. Never throws.
 *
 * | input | stored as |
 * |---|---|
 * | `string` | capped at 256 code points (no redaction here — that is `redactDeep`'s job) |
 * | `null` / `undefined` | `""` (an explicit empty value, not "absent") |
 * | `number` | `String(n)` (`3` → `"3"`, `NaN` → `"NaN"`) |
 * | `boolean` | `"true"` / `"false"` |
 * | `bigint` | `value.toString()` (`10n` → `"10"`) |
 * | object / array | `JSON.stringify`, capped at 512 characters; `"[unserializable]"` for cycles |
 * | function / symbol | `""` (nothing meaningful to attribute) |
 *
 * Why stringify objects instead of dropping them: the card asks for a
 * documented policy and forbids throwing. Coercion keeps the host's intent
 * visible; the cap keeps a nested payload out of the database.
 */
function tagValue(value: unknown): string {
  if (typeof value === "string") return cap(value, MAX_TAG_VALUE_LENGTH)
  if (value === null || value === undefined) return ""
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value) ?? ""
      return cap(json, MAX_TAG_JSON_LENGTH)
    } catch {
      // A cyclic structure or a throwing `toJSON` must not reach the host.
      return "[unserializable]"
    }
  }
  return ""
}

/**
 * Sanitise and redact one host-supplied tag map.
 *
 * Returns `undefined` for anything that is not a plain object, so a
 * wrongly-typed `tags` is dropped silently — the same "ignore the malformed
 * input" choice the rest of this feature makes (never throw, never block).
 *
 * Key/value policy:
 * - a key that is not a string, is empty after trimming, or is longer than 64
 *   characters ⇒ the pair is **dropped** (see `MAX_TAG_KEY_LENGTH`);
 * - `__proto__` is dropped: assigning it would touch the object prototype
 *   rather than add an own property;
 * - every value goes through `tagValue()` and then the whole map through
 *   `redactDeep()`, which additionally clears values under secret-looking keys
 *   (`api_key`, `authorization`, `…token`) entirely.
 */
export function sanitizeTags(tags: unknown): Record<string, string> | undefined {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return undefined
  const output: Record<string, string> = {}
  let count = 0
  for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
    if (typeof key !== "string") continue
    const name = key.trim()
    if (name.length === 0 || name.length > MAX_TAG_KEY_LENGTH) continue
    if (name === "__proto__") continue
    output[name] = tagValue(value)
    count += 1
  }
  if (count === 0) return undefined
  return redactDeep(output)
}

/**
 * The tags worth showing in a **cost breakdown**: the host's own, without the
 * reserved reconciliation namespace. Returns `{}` for an absent or malformed
 * map, which is what keeps an untagged install silent.
 */
export function attributionTags(tags: Record<string, string> | undefined): Record<string, string> {
  if (!tags) return {}
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags)) {
    if (isReservedTagKey(key)) continue
    output[key] = value
  }
  return output
}

/**
 * Redacted, attribution-only tags, for a **rendered** surface.
 *
 * Redaction happens on the write path from EVO-G75 onwards, but a row written by
 * an earlier version can still carry a plaintext token — and this card is the
 * one that opened the CSV column and the breakdown table, so neither may become
 * the channel that prints it. Redacting here covers those rows **without
 * rewriting a stored byte and without a migration**.
 *
 * `UsageEvent.tags` keeps the raw value on purpose: EVO-G73 reconciliation reads
 * it and the contract for that card is that the provider's original text is
 * preserved. Redaction is applied at the edge, not to the data.
 */
export function redactTagsForDisplay(tags: Record<string, string> | undefined): Record<string, string> {
  return redactDeep(attributionTags(tags))
}

/**
 * `key=value` pairs, stable-sorted by key — one CSV cell. The rendering function
 * for the export column, so it redacts (see `redactTagsForDisplay`).
 */
export function tagsToText(tags: Record<string, string> | undefined): string {
  const entries = Object.entries(redactTagsForDisplay(tags)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return entries.map(([key, value]) => `${key}=${value}`).join(" ")
}

/**
 * One breakdown row's `key=value` label, redacted for display.
 *
 * `byTag()` returns the stored text; the label is what a terminal prints, so a
 * row written before EVO-G75 must not leak through this path either. `redact()`
 * sees the whole `key=value` string, so both halves are covered (a
 * secret-looking key clears the value, and a credential-shaped value is masked).
 */
export function tagLabelForDisplay(key: string): string {
  return redact(key)
}
