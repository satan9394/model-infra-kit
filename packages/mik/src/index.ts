/**
 * `model-infra-kit` — an embeddable model layer.
 *
 * ```ts
 * import { ModelInfra } from "model-infra-kit"
 *
 * const mik = await ModelInfra.init({ appId: "my-app", db: ":memory:" })
 * const reply = await mik.generate({ model: "deepseek:deepseek-chat", messages: [...] })
 * ```
 */
export { ModelInfra, type ModelCatalog, type ModelInfraOptions, type ResolvedModelRef } from "./hub.js"
export { createMikFetch, readOpenAiUsage, type FetchTarget, type ForwardedCall, type MikFetchOptions } from "./fetch.js"

export { ModelInfraError, isModelInfraError, toModelInfraError, type ModelInfraErrorCode } from "./errors.js"

export { Store, type StoreOptions } from "./store/database.js"
export { CredentialStore, defaultSecretPath, type CredentialBackend, type CredentialStoreOptions } from "./credential/store.js"

export {
  DEFAULT_MODEL_SETTING,
  MODEL_REF_SEPARATOR,
  PROTOCOL_PACKAGES,
  PROVIDER_PRESETS,
  ProviderRegistry,
  getPreset,
  packageForProtocol,
  splitModelRef,
  type ProviderRegistryDeps,
  type ResolvedProvider,
} from "./registry/index.js"

export {
  PricingService,
  createFileCache,
  type EstimateInput,
  type PricingDeps,
  type PricingServiceDeps,
  type PricingState,
} from "./pricing/index.js"

export { UsageService, type UsageServiceDeps } from "./usage/index.js"

export {
  MODEL_LIST_PROTOCOLS,
  SDK_PROTOCOLS,
  createAiBridge,
  loadProviderFactory,
  type AiBridge,
  type AiBridgeDeps,
  type DiscoveredModel,
  type ModelListProtocol,
  type ProviderFactory,
  type SdkProtocol,
} from "./ai/index.js"

export { maskSecret, redact, redactDeep } from "./util/redact.js"
export { defaultCacheDir, defaultDbPath, expandPath } from "./util/paths.js"

export type {
  CostInfo,
  ModelCapabilities,
  ModelInfo,
  ModelInfraConfig,
  ModelPricing,
  ModelRequest,
  ModelResponse,
  ModelSource,
  PriceBasis,
  PriceSource,
  Protocol,
  ProviderConfig,
  ProviderPreset,
  ProviderRecord,
  ProviderStatus,
  StreamEvent,
  TokenUsage,
  ToolCall,
  UsageBucket,
  UsageEvent,
  UsageEventInput,
  UsagePage,
  UsageQuery,
  UsageSummary,
  UsageTrendPoint,
} from "./types.js"
