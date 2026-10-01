import type { ModelInfo } from "./types.ts"

export const CAPABILITY_FILTERS = [
  { key: "reasoning", label: "Reasoning / 推理" },
  { key: "vision", label: "Vision / 视觉" },
  { key: "tools", label: "Function Calling / 工具" },
  { key: "long", label: "Long Context / 长上下文" },
  { key: "fast", label: "Fast / 快速" },
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
