import type { CredentialStore } from "../credential/store.js"
import { ModelInfraError } from "../errors.js"
import type { Store } from "../store/database.js"
import type { Protocol, ProviderConfig, ProviderRecord } from "../types.js"
import { PROTOCOL_PACKAGES, getPreset } from "./presets.js"

/** The separator between provider id and model id in a `provider:model` ref. */
export const MODEL_REF_SEPARATOR = ":"

/** Settings key holding the default `provider:model` reference. */
export const DEFAULT_MODEL_SETTING = "default_model"

/** A provider record plus everything needed to actually talk to it. */
export interface ResolvedProvider {
  record: ProviderRecord
  /**
   * `null` means no credential reference is configured. The `@ai-sdk/*` factory
   * may still pick up its own conventional environment variable.
   */
  apiKey: string | null
  baseUrl?: string
  protocol: Protocol
  npmPackage: string
}

export interface ProviderRegistryDeps {
  store: Store
  credentials: CredentialStore
  appId: string
  onWarn?: (message: string, error?: unknown) => void
}

/** Split `provider:model` at the first separator; returns null when malformed. */
export function splitModelRef(ref: string): { providerId: string; modelId: string } | null {
  const trimmed = ref.trim()
  const index = trimmed.indexOf(MODEL_REF_SEPARATOR)
  if (index <= 0 || index === trimmed.length - 1) return null
  return { providerId: trimmed.slice(0, index), modelId: trimmed.slice(index + 1) }
}

function joinModelRef(providerId: string, modelId: string): string {
  return `${providerId}${MODEL_REF_SEPARATOR}${modelId}`
}

/**
 * The configured providers of one host.
 *
 * Provider ids are globally unique (they are the primary key), so `list` and
 * `get` are not scoped by app; `appId` is stamped on records at creation time.
 */
export class ProviderRegistry {
  constructor(private readonly deps: ProviderRegistryDeps) {}

  list(): ProviderRecord[] {
    return this.deps.store.providers.list()
  }

  get(id: string): ProviderRecord | null {
    return this.deps.store.providers.get(id)
  }

  /** Add or replace a provider, completing it from its preset when one is named. */
  add(config: ProviderConfig): ProviderRecord {
    const preset = config.presetId ? getPreset(config.presetId) : undefined
    if (config.presetId && !preset) {
      throw new ModelInfraError(`Unknown provider preset "${config.presetId}".`, {
        code: "INVALID_REQUEST",
        providerId: config.id,
      })
    }

    const baseUrl = config.baseUrl ?? preset?.defaultBaseUrl
    // A caller may legitimately omit `protocol` at runtime (CLI, JSON config),
    // so it is read as optional even though the type marks it required.
    const declared = config.protocol as Protocol | undefined
    const protocol = declared ?? preset?.protocol ?? (baseUrl ? "openai-compatible" : undefined)
    if (!protocol) {
      throw new ModelInfraError(
        `Provider "${config.id}" needs a presetId, an explicit protocol or a baseUrl.`,
        { code: "INVALID_REQUEST", providerId: config.id },
      )
    }
    if (!PROTOCOL_PACKAGES[protocol]) {
      throw new ModelInfraError(`Unsupported protocol "${protocol}" for provider "${config.id}".`, {
        code: "INVALID_REQUEST",
        providerId: config.id,
      })
    }

    return this.deps.store.providers.upsert(
      {
        ...config,
        name: config.name ?? preset?.name,
        protocol,
        baseUrl,
        npmPackage: config.npmPackage ?? preset?.npmPackage ?? PROTOCOL_PACKAGES[protocol],
      },
      this.deps.appId,
    )
  }

  remove(id: string): boolean {
    return this.deps.store.providers.remove(id)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.deps.store.providers.setEnabled(id, enabled)
  }

  /** Resolve a provider to its record, protocol and secret. */
  resolve(id: string): ResolvedProvider {
    const record = this.deps.store.providers.get(id)
    if (!record) {
      throw new ModelInfraError(`Provider "${id}" is not configured.`, {
        code: "PROVIDER_NOT_FOUND",
        providerId: id,
      })
    }

    const preset = record.presetId ? getPreset(record.presetId) : undefined
    const protocol = (record.protocol ?? preset?.protocol) as Protocol
    const npmPackage = record.npmPackage ?? preset?.npmPackage ?? PROTOCOL_PACKAGES[protocol]
    if (!npmPackage) {
      throw new ModelInfraError(`Provider "${id}" uses unsupported protocol "${String(protocol)}".`, {
        code: "INVALID_REQUEST",
        providerId: id,
      })
    }

    // Throws ModelInfraError(CREDENTIAL) when the ref cannot be resolved.
    const apiKey = record.apiKeyRef ? this.deps.credentials.resolve(record.apiKeyRef) : null

    return {
      record,
      apiKey,
      baseUrl: record.baseUrl ?? preset?.defaultBaseUrl,
      protocol,
      npmPackage,
    }
  }

  /** The `provider:model` used when a request omits a model. */
  defaultModel(): string | null {
    return this.deps.store.settings.get(DEFAULT_MODEL_SETTING)
  }

  setDefaultModel(ref: string): void {
    const parsed = splitModelRef(ref)
    if (!parsed) {
      throw new ModelInfraError(
        `Default model must look like "provider${MODEL_REF_SEPARATOR}model", got "${ref}".`,
        { code: "INVALID_REQUEST" },
      )
    }
    this.deps.store.settings.set(DEFAULT_MODEL_SETTING, joinModelRef(parsed.providerId, parsed.modelId))
  }

  /** Register the given providers, skipping the ones that already exist. */
  seed(configs: ProviderConfig[]): void {
    for (const config of configs) {
      if (this.deps.store.providers.get(config.id)) continue
      try {
        this.add(config)
      } catch (error) {
        this.deps.onWarn?.(`Could not register provider "${config.id}".`, error)
      }
    }
  }
}
