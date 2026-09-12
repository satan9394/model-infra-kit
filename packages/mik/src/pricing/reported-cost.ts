/**
 * Provider-reported billing amounts (EVO-G73).
 *
 * Some providers — and, in this product's main user scenario, the aggregating /
 * relay endpoints a host points at — return the amount they actually billed
 * instead of leaving the cost to be estimated from a price catalogue. When they
 * do, that amount is the ground truth and the catalogue estimate is only a
 * guess.
 *
 * ## The one shape this module accepts, and why
 *
 * The shape is **measured**, not quoted from a document: `.tmp/probe-g73.mjs`
 * drives an OpenAI-compatible mock through the installed AI SDK v7 and prints
 * what actually survives. Results:
 *
 * | carrier                                     | `usage.cost` present?        |
 * | ------------------------------------------- | ---------------------------- |
 * | `generateText` → `result.providerMetadata`   | **no** (`{ mock: {} }`)      |
 * | `generateText` → `result.usage.raw`          | no (`undefined`)             |
 * | `generateText` → `result.steps[i].usage.raw` | **yes**                      |
 * | `streamText` → `finish-step` part `.usage.raw` | **yes**                    |
 * | `streamText` → `finish` part `.totalUsage`   | no (`raw` dropped)           |
 * | `src/fetch.ts` (this module's own adapter)   | **yes** — it parses the body |
 *
 * So the carrier is the SDK's `usage.raw` ("raw usage information from the
 * provider"), **not** `providerMetadata`, and the raw OpenAI-compatible envelope
 * `{ "usage": { ..., "cost": "0.000123" } }` is the envelope `usage.raw` holds.
 *
 * ## Unit: USD dollars, always
 *
 * `cost` is a **USD dollar** amount whether it arrives as a JSON number or as a
 * decimal string; `0.000123` is 123 micro-USD either way. That is the
 * OpenAI-compatible usage-accounting convention. An integer is still dollars
 * (`1` → $1 → 1_000_000 µ$).
 *
 * This module deliberately does **not** guess a micro-USD / "ticks" unit: a
 * wrong guess misbills by a factor of 10^6, which is worse than not using the
 * reported amount at all. A host whose endpoint reports ticks must convert at
 * its own edge; the alternative — sniffing magnitudes — is exactly the silent
 * mis-billing this feature exists to remove.
 *
 * `usage.cost_details.upstream_inference_cost` is explicitly **not** read: it is
 * what the gateway paid its own upstream, not what the caller is billed.
 */
import type { CostInfo } from "../types.js"

/** Tag keys reserved on `usage_events.tags_json` for reconciliation. */
export const PROVIDER_COST_RAW_TAG = "provider_cost_raw"
export const PROVIDER_COST_STATUS_TAG = "provider_cost_status"

/**
 * Field names an OpenAI-compatible `usage` object uses for the billed amount,
 * most specific first. `cost_details` is a nested object and is skipped by
 * construction: only scalar fields are considered.
 */
const USAGE_COST_FIELDS = ["cost", "cost_usd", "costUsd", "costInUsd", "total_cost", "reportedCost"] as const

/** Field names a provider-metadata namespace uses for the billed amount. */
const METADATA_COST_FIELDS = ["cost", "costUsd", "costInUsd", "total_cost", "reportedCost"] as const

/**
 * What one carrier said about the money. A missing field is `absent` (the
 * provider did not report), which is never the same as `0` — `docs/SPEC.md` §4.
 */
export type ProviderCostReading =
  | { kind: "absent" }
  | { kind: "accepted"; micros: number; raw: string }
  | { kind: "rejected"; raw: string; reason: string }

const ABSENT: ProviderCostReading = { kind: "absent" }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The value as a string, for the reconciliation tag. Never throws. */
function rawText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Normalise one raw reported value to integer micro-USD (rule 2), keeping the
 * original text for troubleshooting.
 *
 * Every rejection is a **fallback**, never a zero: the caller keeps the
 * catalogue estimate and the raw value is still recorded with its reason, so a
 * mis-shaped upstream field is visible instead of silently billing $0.
 */
export function readReportedCostUsd(value: unknown): ProviderCostReading {
  if (value === undefined || value === null) return ABSENT
  const raw = rawText(value)
  if (typeof value === "boolean" || typeof value === "object") {
    return { kind: "rejected", raw, reason: "not a scalar amount" }
  }
  const text = typeof value === "string" ? value.trim() : ""
  if (typeof value === "string" && !DECIMAL.test(text)) {
    return { kind: "rejected", raw, reason: "not a decimal amount" }
  }
  const usd = typeof value === "number" ? value : Number(text)
  if (!Number.isFinite(usd)) return { kind: "rejected", raw, reason: "not a finite amount" }
  if (usd < 0) return { kind: "rejected", raw, reason: "negative amount" }
  const micros = Math.round(usd * 1_000_000)
  if (!Number.isSafeInteger(micros)) return { kind: "rejected", raw, reason: "amount out of range" }
  // A positive amount too small to survive the micro-USD round trip would be
  // stored as 0 — i.e. "free" — which is the silent zero this feature forbids.
  // An explicit `0` is different: that is the provider stating the call was
  // free, and it is kept (with `source: "provider"`, so the claim is attributable).
  if (micros === 0 && usd !== 0) return { kind: "rejected", raw, reason: "rounds down to zero micro-USD" }
  return { kind: "accepted", micros, raw }
}

/**
 * Read the billed amount out of one provider usage record — an
 * OpenAI-compatible `usage` object, or the SDK's `usage.raw`, which holds that
 * same object shape.
 */
export function reportedCostFromUsage(record: unknown): ProviderCostReading {
  const usage = asRecord(record)
  if (!usage) return ABSENT
  for (const field of USAGE_COST_FIELDS) {
    const reading = readReportedCostUsd(usage[field])
    if (reading.kind !== "absent") return reading
  }
  return ABSENT
}

/**
 * Read the billed amount out of AI SDK provider metadata, for providers that
 * populate it (`{ openrouter: { usage: { cost } } }`, `{ <name>: { cost } }`).
 *
 * Measured against `@ai-sdk/openai-compatible`, the namespace is present but
 * empty, so this is a *secondary* carrier; the primary one is `usage.raw`.
 */
export function reportedCostFromProviderMetadata(metadata: unknown): ProviderCostReading {
  const namespaces = asRecord(metadata)
  if (!namespaces) return ABSENT
  for (const namespace of Object.values(namespaces)) {
    const entry = asRecord(namespace)
    if (!entry) continue
    const nested = reportedCostFromUsage(entry.usage)
    if (nested.kind !== "absent") return nested
    for (const field of METADATA_COST_FIELDS) {
      const reading = readReportedCostUsd(entry[field])
      if (reading.kind !== "absent") return reading
    }
  }
  return ABSENT
}

/** The raw values that were actually present, as one string for the tag. */
function joinRaws(readings: readonly ProviderCostReading[]): string {
  const raws: string[] = []
  for (const reading of readings) {
    if (reading.kind !== "absent") raws.push(reading.raw)
  }
  const [first] = raws
  return raws.length === 1 && first !== undefined ? first : JSON.stringify(raws)
}

/**
 * Fold the per-call readings of one usage row into a single decision.
 *
 * Adoption is **atomic**: the reported amount is used only when every call in
 * the row reported an amount this module could read. A row where one call
 * reported nothing (or reported something unusable) falls back to the catalogue
 * as a whole, because a partial sum would silently under-bill the calls whose
 * amount is missing — the same failure mode as writing 0.
 *
 * With one reading — the normal single-step call — this is just that reading.
 */
export function combineReportedCosts(readings: readonly ProviderCostReading[]): ProviderCostReading {
  if (readings.length === 0) return ABSENT
  let present = 0
  let micros = 0
  let incomplete = false
  for (const reading of readings) {
    if (reading.kind === "absent") {
      incomplete = true
      continue
    }
    present += 1
    if (reading.kind === "rejected") {
      return { kind: "rejected", raw: joinRaws(readings), reason: reading.reason }
    }
    micros += reading.micros
  }
  const raw = joinRaws(readings)
  if (present === 0) return ABSENT
  if (incomplete) {
    return {
      kind: "rejected",
      raw,
      reason: `only ${present} of ${readings.length} calls reported a usable amount`,
    }
  }
  if (!Number.isSafeInteger(micros)) return { kind: "rejected", raw, reason: "total out of range" }
  return { kind: "accepted", micros, raw }
}

/**
 * Turn an accepted, normalised amount into a `CostInfo`.
 *
 * `basis: "exact"` and `low === high === usd`: a billed amount carries no
 * estimate band, and `"exact"` is the existing vocabulary's word for that (as
 * opposed to `"flat"`, which marks a placeholder like `MISSING_COST`). The
 * catalogue's `pricingModel` / `providerId` are carried over so a reconciler can
 * still see which card would have applied.
 *
 * `usd` is `micros / 1e6`, so the value round-trips through the stored REAL
 * column back to exactly the same integer micro-USD under rule 2's
 * `CAST(ROUND(cost_usd * 1000000) AS INTEGER)`.
 */
export function providerCostInfo(input: { micros: number; pricingModel?: string; providerId?: string }): CostInfo {
  const usd = input.micros / 1_000_000
  return {
    usd,
    low: usd,
    high: usd,
    basis: "exact",
    source: "provider",
    ...(input.pricingModel === undefined ? {} : { pricingModel: input.pricingModel }),
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
  }
}

/**
 * The reconciliation tags for one reading, merged into the event's `tags`.
 *
 * Nothing is added when no provider reported an amount, so the absent case stays
 * byte-identical to the behaviour before this feature existed. The raw value is
 * kept even when it was rejected, together with the reason — otherwise a
 * mis-shaped upstream field would leave no trace anywhere.
 */
export function providerCostTags(reading: ProviderCostReading): Record<string, string> {
  switch (reading.kind) {
    case "absent":
      return {}
    case "accepted":
      return { [PROVIDER_COST_RAW_TAG]: reading.raw, [PROVIDER_COST_STATUS_TAG]: "accepted" }
    case "rejected":
      return { [PROVIDER_COST_RAW_TAG]: reading.raw, [PROVIDER_COST_STATUS_TAG]: `rejected: ${reading.reason}` }
  }
}
