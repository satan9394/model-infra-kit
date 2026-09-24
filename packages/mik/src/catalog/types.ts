import type { Protocol } from "../types.js"

/** Public capabilities for provider-independent model facts. */
export interface CatalogModelCapabilities {
  reasoning: boolean
  reasoningEffortLevels?: readonly ("none" | "low" | "medium" | "high" | "xhigh" | "max")[]
  vision: boolean
  audio?: boolean
  tools: boolean
  structuredOutputs: boolean
}

/** A canonical model description, independent of the provider serving it. */
export interface ModelMetadata {
  id: string
  family: string
  name: string
  contextWindow: number
  maxOutputTokens?: number
  knowledgeCutoff?: string
  capabilities: CatalogModelCapabilities
  /** Data source for this point-in-time snapshot. */
  source: string
  sourceUrl: string
  /** Provider record used as the source of canonical facts, when applicable. */
  sourceProviderId?: string
}

export type CatalogCapability = "reasoning" | "vision" | "audio" | "tools" | "structuredOutputs"

export type ProviderModelBindingStatus = "available" | "deprecated" | "preview"

/** A provider-specific endpoint name for a provider-independent model id. */
export interface ProviderModelBinding {
  providerId: string
  protocol: Protocol
  modelId: string
  upstreamModelName: string
  status: ProviderModelBindingStatus
}

export interface ModelFilter {
  family?: string
  providerId?: string
  protocol?: Protocol
  capability?: CatalogCapability
  status?: ProviderModelBindingStatus
}

export interface BindingFilter {
  modelId?: string
  providerId?: string
  protocol?: Protocol
  status?: ProviderModelBindingStatus
}
