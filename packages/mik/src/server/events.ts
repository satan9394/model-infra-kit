import type { ModelInfra } from "../hub.js"
import type { PricingState } from "../pricing/service.js"
import type { ModelInfo, UsageEvent } from "../types.js"

/** The three topics `GET /api/events` publishes, per `docs/interfaces.md`. */
export type HubEventName = "usage.recorded" | "catalog.updated" | "pricing.updated"

export interface HubEvent {
  type: HubEventName
  at: number
  data: unknown
}

type Listener = (event: HubEvent) => void

/**
 * A tiny synchronous fan-out. SSE clients subscribe for the lifetime of their
 * connection; a listener that throws is dropped from that one delivery rather
 * than breaking the producer.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: HubEvent): void {
    // Copy first: a listener may unsubscribe while being notified.
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A broken subscriber must not break metering or the other clients.
      }
    }
  }

  get size(): number {
    return this.listeners.size
  }
}

/**
 * `UsageService`, `ModelCatalog` and `PricingService` have no public
 * subscription hook yet (see `docs/interfaces.md`), and a server created from an
 * already-built hub cannot inject `ModelInfraOptions.onUsage`. The bridge
 * therefore wraps the four mutating entry points and republishes them as SSE
 * events. Wrapping is idempotent per hub and fully reversible: `dispose()`
 * restores the original methods, so a closed server leaves the hub untouched.
 *
 * The wrapper always calls through to the original first, so a host that did
 * pass `onUsage` keeps receiving its own events.
 */
interface Bridge {
  bus: EventBus
  refs: number
  dispose: () => void
}

const bridges = new WeakMap<ModelInfra, Bridge>()

function tapUsage(hub: ModelInfra, bus: EventBus): () => void {
  const usage = hub.usage
  const original = usage.record
  usage.record = function record(this: typeof usage, event) {
    const stored = original.call(this, event)
    if (stored) {
      const full: UsageEvent = { ...event, appId: event.appId ?? usage.currentAppId }
      bus.emit({ type: "usage.recorded", at: Date.now(), data: full })
    }
    return stored
  }
  return () => {
    usage.record = original
  }
}

function tapCatalog(hub: ModelInfra, bus: EventBus): () => void {
  const catalog = hub.models
  const original = catalog.refresh
  catalog.refresh = async (providerId: string): Promise<ModelInfo[]> => {
    const models = await original.call(catalog, providerId)
    bus.emit({ type: "catalog.updated", at: Date.now(), data: { providerId, models: models.length } })
    return models
  }
  return () => {
    catalog.refresh = original
  }
}

function tapPricing(hub: ModelInfra, bus: EventBus): () => void {
  const pricing = hub.pricing
  const setOverride = pricing.setOverride
  const removeOverride = pricing.removeOverride
  const refresh = pricing.refresh

  pricing.setOverride = (override) => {
    setOverride.call(pricing, override)
    bus.emit({ type: "pricing.updated", at: Date.now(), data: { action: "set", modelId: override.modelId } })
  }
  pricing.removeOverride = (modelId: string): boolean => {
    const removed = removeOverride.call(pricing, modelId)
    bus.emit({ type: "pricing.updated", at: Date.now(), data: { action: "remove", modelId, removed } })
    return removed
  }
  pricing.refresh = async (): Promise<PricingState> => {
    const state = await refresh.call(pricing)
    bus.emit({ type: "pricing.updated", at: Date.now(), data: { action: "sync", status: state.status } })
    return state
  }

  return () => {
    pricing.setOverride = setOverride
    pricing.removeOverride = removeOverride
    pricing.refresh = refresh
  }
}

/**
 * The bus for this hub, shared by every server created from it. The returned
 * `release` must be called on `close()`; the last release unwraps the hub.
 */
export function acquireEventBus(hub: ModelInfra): { bus: EventBus; release: () => void } {
  const existing = bridges.get(hub)
  if (existing) {
    existing.refs += 1
    return { bus: existing.bus, release: () => releaseBridge(hub, existing) }
  }

  const bus = new EventBus()
  const restores = [tapUsage(hub, bus), tapCatalog(hub, bus), tapPricing(hub, bus)]
  const bridge: Bridge = {
    bus,
    refs: 1,
    dispose: () => {
      // Unwrap in reverse order so each restore puts back what it wrapped.
      for (const restore of restores.reverse()) restore()
    },
  }
  bridges.set(hub, bridge)
  return { bus, release: () => releaseBridge(hub, bridge) }
}

function releaseBridge(hub: ModelInfra, bridge: Bridge): void {
  bridge.refs -= 1
  if (bridge.refs > 0) return
  bridge.dispose()
  bridges.delete(hub)
}
