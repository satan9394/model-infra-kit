import type { MultimodalUsage, TokenUsage } from "../types.js"
export type { MultimodalUsage } from "../types.js"

export type ModelPricingTierSource = "builtin" | "synced" | "manual"

export interface PriceRule {
  image_per_megapixel_micros?: number
  audio_input_micros_per_second?: number
  audio_output_micros_per_second?: number
}

export function validateMultimodalUsage(media: MultimodalUsage | undefined): void {
  if (media === undefined) return
  if (!media || typeof media !== "object" || Array.isArray(media)) throw new RangeError("media facts must be an object")
  for (const key of ["image_pixels", "audio_input_ms", "audio_output_ms"] as const) {
    const value = media[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("media facts must be non-negative safe integers")
  }
}

export interface ModelPricingTierRates extends PriceRule {
  inputMicrosPerMillion: number
  cachedInputMicrosPerMillion?: number
  cacheWriteMicrosPerMillion?: number
  outputMicrosPerMillion: number
  reasoningOutputMicrosPerMillion?: number
  longContextThresholdTokens?: number
  longContextInputMultiplier?: number
  longContextOutputMultiplier?: number
}

export interface ModelPricingTier {
  modelId: string
  providerId: string
  source: ModelPricingTierSource
  version: number
  updatedAt: string
  rates: ModelPricingTierRates
}

export interface ModelPricingTierInput extends PriceRule {
  modelId: string
  providerId: string
  source: ModelPricingTierSource
  updatedAt: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM?: number
  cacheWritePerM?: number
  reasoningOutputPerM?: number
  longContextThresholdTokens?: number
  longContextInputMultiplier?: number
  longContextOutputMultiplier?: number
}

const MICRO_USD_PER_USD = 1_000_000n
const TOKENS_PER_MILLION = 1_000_000n
const MULTIPLIER_SCALE = 1_000_000n
const COST_DENOMINATOR = TOKENS_PER_MILLION * MULTIPLIER_SCALE
const SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Convert a USD-per-million rate to integer micro-USD per million tokens.
 * Decimal text parsing avoids carrying binary floating-point noise into the
 * rate card. Any rounding happens once, at the rate's micro-USD boundary.
 */
function usdPerMillionToMicros(value: number): number {
  return toSafeNumber(decimalScaled(value, MICRO_USD_PER_USD))
}

function decimalScaled(value: number, scale: bigint): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("pricing rates must be finite and non-negative")
  const [coefficient = "", exponentText] = value.toString().toLowerCase().split("e")
  const exponent = exponentText === undefined ? 0 : Number(exponentText)
  const [whole = "0", fraction = ""] = coefficient.split(".")
  const digits = `${whole}${fraction}`
  let numerator = BigInt(digits || "0")
  const power = exponent - fraction.length
  let denominator = 1n
  if (power >= 0) numerator *= 10n ** BigInt(power)
  else denominator = 10n ** BigInt(-power)
  const scaled = numerator * scale
  return (scaled + denominator / 2n) / denominator
}

function toSafeNumber(value: bigint): number {
  if (value > SAFE_INTEGER_MAX) throw new RangeError("pricing rate exceeds safe integer micro-USD precision")
  return Number(value)
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}

function gpt6Model(modelId: string): boolean {
  const tail = modelId.toLowerCase().split(":").at(-1)?.split("/").at(-1)
  return tail === "gpt-6-luna" || tail === "gpt-6-sol" || tail === "gpt-6-astra"
}

/**
 * Build an integer-only tier from USD-per-million rates. GPT-6 defaults are
 * relative to the provider's current base rates, so no base price is invented:
 * cache reads cost 10%, writes 125%, and reasoning follows output unless an
 * explicit thinking rate is supplied.
 */
export function deriveModelPricingTier(input: ModelPricingTierInput): ModelPricingTier {
  const modelIsGpt6 = gpt6Model(input.modelId)
  const inputRate = usdPerMillionToMicros(input.inputPerM)
  const outputRate = usdPerMillionToMicros(input.outputPerM)
  const rates: ModelPricingTierRates = {
    inputMicrosPerMillion: inputRate,
    cachedInputMicrosPerMillion:
      input.cacheReadPerM === undefined
        ? modelIsGpt6
          ? toSafeNumber(roundedRatio(BigInt(inputRate), 10n))
          : inputRate
        : usdPerMillionToMicros(input.cacheReadPerM),
    cacheWriteMicrosPerMillion:
      input.cacheWritePerM === undefined
        ? modelIsGpt6
          ? toSafeNumber(roundedRatio(BigInt(inputRate) * 125n, 100n))
          : inputRate
        : usdPerMillionToMicros(input.cacheWritePerM),
    outputMicrosPerMillion: outputRate,
  }

  const reasoningRate = input.reasoningOutputPerM ?? (modelIsGpt6 ? input.outputPerM : undefined)
  for (const key of ["image_per_megapixel_micros", "audio_input_micros_per_second", "audio_output_micros_per_second"] as const) {
    const rate = input[key]
    if (rate !== undefined) {
      if (!Number.isSafeInteger(rate) || rate < 0) throw new RangeError("media rates must be non-negative safe integer micros")
      rates[key] = rate
    }
  }
  if (reasoningRate !== undefined) rates.reasoningOutputMicrosPerMillion = usdPerMillionToMicros(reasoningRate)
  if (Number.isSafeInteger(input.longContextThresholdTokens) && (input.longContextThresholdTokens ?? 0) > 0) {
    rates.longContextThresholdTokens = input.longContextThresholdTokens
  }
  if (Number.isFinite(input.longContextInputMultiplier) && (input.longContextInputMultiplier ?? 0) > 0) {
    rates.longContextInputMultiplier = input.longContextInputMultiplier
  }
  if (Number.isFinite(input.longContextOutputMultiplier) && (input.longContextOutputMultiplier ?? 0) > 0) {
    rates.longContextOutputMultiplier = input.longContextOutputMultiplier
  }

  return {
    modelId: input.modelId,
    providerId: input.providerId,
    source: input.source,
    version: 1,
    updatedAt: input.updatedAt,
    rates,
  }
}

function tokenCount(value: number | undefined): bigint {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : 0n
}

function multiplierScaled(value: number | undefined, enabled: boolean): bigint {
  return enabled && value !== undefined ? decimalScaled(value, MULTIPLIER_SCALE) : MULTIPLIER_SCALE
}

/** Compute both exact bounds. A concrete rate card has equal low/high costs. */
export function calculateTierCostMicros(
  tier: ModelPricingTier,
  usage: Partial<TokenUsage>,
  media?: MultimodalUsage,
): { costLowMicros: number; costHighMicros: number } {
  validateMultimodalUsage(media)
  const input = usage.input === undefined ? undefined : tokenCount(usage.input)
  const reportedRead = tokenCount(usage.cacheRead)
  const reportedWrite = tokenCount(usage.cacheWrite)
  const cacheRead = input === undefined ? reportedRead : reportedRead < input ? reportedRead : input
  const afterRead = input === undefined ? undefined : input - cacheRead
  const cacheWrite = afterRead === undefined ? reportedWrite : reportedWrite < afterRead ? reportedWrite : afterRead
  const freshInput = afterRead === undefined ? 0n : afterRead - cacheWrite

  const output = usage.output === undefined ? undefined : tokenCount(usage.output)
  const reasoning = tokenCount(usage.reasoning)
  const reasoningOutput = output === undefined ? reasoning : reasoning < output ? reasoning : output
  const textOutput = output === undefined ? 0n : output - reasoningOutput
  const longContext =
    input !== undefined &&
    tier.rates.longContextThresholdTokens !== undefined &&
    input >= tier.rates.longContextThresholdTokens

  const inputMultiplier = multiplierScaled(tier.rates.longContextInputMultiplier, longContext)
  const outputMultiplier = multiplierScaled(tier.rates.longContextOutputMultiplier, longContext)
  const cachedRate = BigInt(tier.rates.cachedInputMicrosPerMillion ?? tier.rates.inputMicrosPerMillion)
  const cacheWriteRate = BigInt(tier.rates.cacheWriteMicrosPerMillion ?? tier.rates.inputMicrosPerMillion)
  const reasoningRate = BigInt(tier.rates.reasoningOutputMicrosPerMillion ?? tier.rates.outputMicrosPerMillion)

  const numerator =
    BigInt(tier.rates.inputMicrosPerMillion) * freshInput * inputMultiplier +
    cachedRate * cacheRead * inputMultiplier +
    cacheWriteRate * cacheWrite * inputMultiplier +
    BigInt(tier.rates.outputMicrosPerMillion) * textOutput * outputMultiplier +
    reasoningRate * reasoningOutput * outputMultiplier
  // All units share this denominator; round exactly once after summing text + media.
  const mediaNumerator =
    BigInt(tier.rates.image_per_megapixel_micros ?? 0) * BigInt(media?.image_pixels ?? 0) * MULTIPLIER_SCALE +
    BigInt(tier.rates.audio_input_micros_per_second ?? 0) * BigInt(media?.audio_input_ms ?? 0) * (COST_DENOMINATOR / 1000n) +
    BigInt(tier.rates.audio_output_micros_per_second ?? 0) * BigInt(media?.audio_output_ms ?? 0) * (COST_DENOMINATOR / 1000n)
  const micros = toSafeNumber(roundedRatio(numerator + mediaNumerator, COST_DENOMINATOR))
  return { costLowMicros: micros, costHighMicros: micros }
}

export function isModelPricingTier(value: unknown): value is ModelPricingTier {
  if (!value || typeof value !== "object") return false
  const tier = value as Partial<ModelPricingTier>
  const rates = tier.rates
  if (
    typeof tier.modelId !== "string" ||
    !tier.modelId ||
    typeof tier.providerId !== "string" ||
    !tier.providerId ||
    !["builtin", "synced", "manual"].includes(tier.source ?? "") ||
    !Number.isSafeInteger(tier.version) ||
    typeof tier.updatedAt !== "string" ||
    !rates ||
    typeof rates !== "object"
  ) return false
  const validRate = (rate: unknown) => typeof rate === "number" && Number.isSafeInteger(rate) && rate >= 0
  return (
    validRate(rates.inputMicrosPerMillion) &&
    validRate(rates.outputMicrosPerMillion) &&
    (rates.image_per_megapixel_micros === undefined || validRate(rates.image_per_megapixel_micros)) &&
    (rates.audio_input_micros_per_second === undefined || validRate(rates.audio_input_micros_per_second)) &&
    (rates.audio_output_micros_per_second === undefined || validRate(rates.audio_output_micros_per_second)) &&
    (rates.cachedInputMicrosPerMillion === undefined || validRate(rates.cachedInputMicrosPerMillion)) &&
    (rates.cacheWriteMicrosPerMillion === undefined || validRate(rates.cacheWriteMicrosPerMillion)) &&
    (rates.reasoningOutputMicrosPerMillion === undefined || validRate(rates.reasoningOutputMicrosPerMillion)) &&
    (rates.longContextThresholdTokens === undefined ||
      (Number.isSafeInteger(rates.longContextThresholdTokens) && rates.longContextThresholdTokens > 0)) &&
    (rates.longContextInputMultiplier === undefined ||
      (Number.isFinite(rates.longContextInputMultiplier) && rates.longContextInputMultiplier > 0)) &&
    (rates.longContextOutputMultiplier === undefined ||
      (Number.isFinite(rates.longContextOutputMultiplier) && rates.longContextOutputMultiplier > 0))
  )
}
