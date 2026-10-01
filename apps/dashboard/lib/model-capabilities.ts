import { message } from "./i18n/core.ts"
import type { ModelInfo } from "./types.ts"

export const CAPABILITY_FILTERS = [
  { key: "reasoning", label: message("s388") },
  { key: "vision", label: message("s389") },
  { key: "tools", label: message("s390") },
  { key: "long", label: message("s391") },
  { key: "fast", label: message("s392") },
] as const
export type CapabilityFilter = typeof CAPABILITY_FILTERS[number]["key"]

export function matchesCapabilities(
  model: Pick<ModelInfo, "modelId" | "ref" | "capabilities" | "contextWindow">,
  filters: readonly CapabilityFilter[],
  firstTokenMs?: number,
): boolean {
  return filters.every((filter) => {
    switch (filter) {
      case "reasoning": return model.capabilities.reasoning
      case "vision": return model.capabilities.image
      case "tools": return model.capabilities.toolCall
      case "long": return (model.contextWindow ?? 0) >= 128_000
      // ponytail: a lightweight name is a hint until a successful probe measures TTFT.
      case "fast": return firstTokenMs !== undefined ? firstTokenMs <= 1000 : /(?:mini|nano|flash|haiku|luna|lite)/i.test(model.modelId)
    }
  })
}

export function latencyLevel(ms: number | null | undefined): "unknown" | "fast" | "normal" | "slow" | "very-slow" {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "unknown"
  return ms <= 500 ? "fast" : ms <= 1500 ? "normal" : ms <= 3000 ? "slow" : "very-slow"
}
export const LATENCY_TONES = {
  unknown: "text-subtle", fast: "text-positive", normal: "text-info", slow: "text-warning", "very-slow": "text-danger",
} as const

export interface ModelPingResult {
  ref: string
  prompt: string
  maxOutputTokens: number
  latencyMs: number
  firstTokenMs: number | null
  dnsMs: number | null
  dnsNote: string
  outputTokens: number
  reasoningTokens: number
  tokensPerSecond: number | null
  text: string
}
