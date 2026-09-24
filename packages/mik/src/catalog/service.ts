import { ModelInfraError } from "../errors.js"
import { MODEL_METADATA, PROVIDER_MODEL_BINDINGS } from "./snapshot.js"
import type {
  BindingFilter,
  CatalogCapability,
  ModelFilter,
  ModelMetadata,
  ProviderModelBinding,
} from "./types.js"
import type { Protocol, ProviderRecord } from "../types.js"

export type CatalogProviderLookup = (providerId: string) => Pick<ProviderRecord, "id" | "presetId" | "protocol" | "enabled"> | null

export interface ModelCatalogServiceOptions {
  models?: readonly ModelMetadata[]
  bindings?: readonly ProviderModelBinding[]
  providerLookup?: CatalogProviderLookup
}

function copyMetadata(model: ModelMetadata): ModelMetadata {
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      reasoningEffortLevels: model.capabilities.reasoningEffortLevels
        ? [...model.capabilities.reasoningEffortLevels]
        : undefined,
    },
  }
}

/** Static query service for canonical facts and provider endpoint bindings. */
export class ModelCatalogService {
  private readonly models: readonly ModelMetadata[]
  private readonly bindings: readonly ProviderModelBinding[]
  private readonly byId: ReadonlyMap<string, ModelMetadata>
  private readonly providerLookup: CatalogProviderLookup | undefined

  constructor(options: ModelCatalogServiceOptions = {}) {
    this.models = options.models ?? MODEL_METADATA
    this.bindings = options.bindings ?? PROVIDER_MODEL_BINDINGS
    this.byId = new Map(this.models.map((model) => [model.id, model]))
    this.providerLookup = options.providerLookup
  }

  list(filter: ModelFilter = {}): ModelMetadata[] {
    return this.models
      .filter((model) => {
        if (filter.family && model.family !== filter.family) return false
        if (filter.capability && !model.capabilities[filter.capability]) return false
        if (filter.providerId || filter.protocol || filter.status) {
          return this.bindings.some(
            (binding) =>
              binding.modelId === model.id &&
              (!filter.providerId || binding.providerId === filter.providerId) &&
              (!filter.protocol || binding.protocol === filter.protocol) &&
              (!filter.status || binding.status === filter.status),
          )
        }
        return true
      })
      .map(copyMetadata)
  }

  get(modelId: string): ModelMetadata | undefined {
    const model = this.byId.get(modelId)
    return model ? copyMetadata(model) : undefined
  }

  listBindings(filter: BindingFilter = {}): ProviderModelBinding[] {
    return this.bindings
      .filter(
        (binding) =>
          (!filter.modelId || binding.modelId === filter.modelId) &&
          (!filter.providerId || binding.providerId === filter.providerId) &&
          (!filter.protocol || binding.protocol === filter.protocol) &&
          (!filter.status || binding.status === filter.status),
      )
      .map((binding) => ({ ...binding }))
  }

  resolveEndpoint(modelId: string, providerId: string): ProviderModelBinding | undefined {
    const provider = this.providerLookup?.(providerId)
    if (provider && !provider.enabled) return undefined
    const providerIds = new Set([providerId, provider?.presetId].filter((value): value is string => Boolean(value)))
    const binding = this.bindings.find(
      (candidate) =>
        candidate.modelId === modelId &&
        providerIds.has(candidate.providerId) &&
        (!provider?.protocol || candidate.protocol === provider.protocol),
    )
    return binding ? { ...binding, providerId } : undefined
  }

  assertCapability(modelId: string, required: CatalogCapability): void {
    const model = this.byId.get(modelId)
    if (!model) {
      throw new ModelInfraError(`Model "${modelId}" was not found in the model catalog.`, {
        code: "MODEL_NOT_FOUND",
        model: modelId,
      })
    }
    if (!model.capabilities[required]) {
      throw new ModelInfraError(`Model "${modelId}" does not support ${required}.`, {
        code: "INVALID_REQUEST",
        model: modelId,
      })
    }
  }
}

export const modelCatalog = new ModelCatalogService()
