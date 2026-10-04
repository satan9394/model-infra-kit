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
export type { ArchiveOptions, ArchiveResult } from "./usage/archive.js"
export { estimateContextTokens, type RouterConfig, type RouterPolicy, type RouterRule } from "./ai/smart-router.js"
export {
  MODEL_CATALOG_SOURCE,
  MODEL_METADATA,
  PROVIDER_MODEL_BINDINGS,
  ModelCatalogService,
  modelCatalog,
  type BindingFilter,
  type CatalogProviderLookup,
  type CatalogCapability,
  type CatalogModelCapabilities,
  type ModelCatalogServiceOptions,
  type ModelFilter,
  type ModelMetadata,
  type ProviderModelBinding,
  type ProviderModelBindingStatus,
} from "./catalog/index.js"
export { createMikFetch, readOpenAiUsage, type FetchTarget, type ForwardedCall, type MikFetchOptions } from "./fetch.js"
// EVO-G73: `ForwardedCall.providerCost` / `readOpenAiUsage().cost` are public, so
// the type they are written in has to be nameable by a host. Type-only export:
// the runtime export set is unchanged.
export type { ProviderCostReading } from "./pricing/reported-cost.js"

export { ModelInfraError, isModelInfraError, toModelInfraError, type ModelInfraErrorCode } from "./errors.js"

export { SqliteStorageAdapter } from "./store/sqlite-adapter.js"
export type { StorageAdapter, PreparedStatement, StorageConfig, StorageAdapterFactory } from "./store/adapter.js"
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
  type PricingSyncOptions,
  type PricingSyncResult,
  type ModelPricingTier,
  type ModelPricingTierRates,
  type ModelPricingTierSource,
  type PriceRule,
  type MultimodalUsage,
} from "./pricing/index.js"

export {
  UsageService,
  checkBudgetStatus,
  type BudgetPeriod,
  type BudgetStatus,
  type BudgetStatusLevel,
  type BudgetUsageReader,
  type BudgetUsageSnapshot,
  type BudgetUsageTotals,
  type UsageServiceDeps,
} from "./usage/index.js"
export { KeyPool, normalizeRefs, type KeyPoolSelection } from "./router/key-pool.js"

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
  ToolCallAttribution,
  UsagePage,
  UsageSearchHit,
  UsageQuery,
  UsageSummary,
  UsageTraceGroup,
  UsageTraceGroupBy,
  UsageTrendPoint,
} from "./types.js"
