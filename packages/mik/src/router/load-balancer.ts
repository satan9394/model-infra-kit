import { ModelInfraError } from "../errors.js"

export interface Channel {
  model: string
  weight?: number
  /** Lower numbers run first; higher priority numbers are standby channels. */
  priority?: number
  maxConcurrency?: number
}
export type LoadBalancerConfig = Record<string, Channel[]>

function invalid(): never {
  throw new ModelInfraError("Invalid load balancer configuration.", { code: "INVALID_REQUEST" })
}

export function readLoadBalancerConfig(value: unknown): LoadBalancerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const result: LoadBalancerConfig = Object.create(null)
  if (Object.keys(value).length > 128) invalid()
  for (const [alias, channels] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(alias) || !Array.isArray(channels) || !channels.length || channels.length > 64) invalid()
    const seen = new Set<string>()
    result[alias] = channels.map((channel: unknown) => {
      if (!channel || typeof channel !== "object" || Array.isArray(channel)) invalid()
      const c = channel as Record<string, unknown>
      if (Object.keys(c).some(key => !["model", "weight", "priority", "maxConcurrency"].includes(key)) || typeof c.model !== "string" || c.model.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(c.model) || seen.has(c.model)) invalid()
      seen.add(c.model)
      for (const key of ["weight", "priority", "maxConcurrency"]) {
        if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || (c[key] as number) < (key === "priority" ? 0 : 1) || (c[key] as number) > 1_000_000)) invalid()
      }
      return { model: c.model, weight: c.weight as number | undefined, priority: c.priority as number | undefined, maxConcurrency: c.maxConcurrency as number | undefined }
    })
  }
  return result
}

interface Slot { active: number; limit: number; queue: Array<() => void> }

/** Smooth weighted round robin, with priority tiers and abortable FIFO leases. */
export class LoadBalancer {
  readonly config: LoadBalancerConfig
  private readonly weights = new Map<string, Map<string, number>>()
  private readonly slots = new Map<string, Slot>()
  constructor(config: LoadBalancerConfig) {
    this.config = readLoadBalancerConfig(config)
    for (const channels of Object.values(this.config)) for (const channel of channels) {
      const limit = channel.maxConcurrency ?? Infinity
      const existing = this.slots.get(channel.model)
      if (existing && existing.limit !== limit) invalid()
      this.slots.set(channel.model, existing ?? { active: 0, limit, queue: [] })
    }
  }
  candidates(alias: string, available: (model: string) => boolean, advance = true): string[] | undefined {
    const configured = this.config[alias]
    if (!configured) return undefined
    const healthy = configured.filter(channel => available(channel.model)).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    if (!healthy.length) throw new ModelInfraError("No healthy channel is available.", { code: "PROVIDER", retryable: true })
    const tier = healthy.filter(channel => (channel.priority ?? 0) === (healthy[0]!.priority ?? 0))
    let selected = tier[0]!
    if (advance) {
      const weights = this.weights.get(alias) ?? new Map<string, number>()
      this.weights.set(alias, weights)
      let total = 0
      for (const channel of tier) {
        total += channel.weight ?? 1
        weights.set(channel.model, (weights.get(channel.model) ?? 0) + (channel.weight ?? 1))
        if (weights.get(channel.model)! > weights.get(selected.model)!) selected = channel
      }
      weights.set(selected.model, weights.get(selected.model)! - total)
    }
    return [selected.model, ...healthy.filter(channel => channel !== selected).map(channel => channel.model)]
  }
  async acquire(model: string, signal?: AbortSignal): Promise<() => void> {
    const slot = this.slots.get(model)
    if (!slot) return () => {}
    signal?.throwIfAborted()
    if (slot.active >= slot.limit) await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = slot.queue.indexOf(ready)
        if (index >= 0) slot.queue.splice(index, 1)
        reject(signal!.reason)
      }
      const ready = () => { signal?.removeEventListener("abort", abort); resolve() }
      slot.queue.push(ready)
      signal?.addEventListener("abort", abort, { once: true })
    })
    else slot.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      const next = slot.queue.shift()
      if (next) next()
      else slot.active -= 1
    }
  }
}
