import { randomUUID } from "node:crypto"
import { redactDeep } from "../util/redact.js"

export const NOTIFICATION_EVENTS = ["USAGE_RECORDED", "BUDGET_EXCEEDED", "FAILOVER_TRIGGERED", "RATE_LIMITED"] as const
export type NotificationType = typeof NOTIFICATION_EVENTS[number]
export interface NotificationEvent { id: string; type: NotificationType; timestamp: number; data: Record<string, unknown> }

/** Bounded deferred work: no listener, serialization or transport runs in emit(). */
export class NotificationBus {
  private readonly pending: Array<() => void> = []
  private readonly listeners = new Set<(event: NotificationEvent) => void>()
  private immediate: NodeJS.Immediate | undefined
  private closed = false
  dropped = 0

  subscribe(listener: (event: NotificationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  defer(work: () => void): boolean {
    if (this.closed) return false
    if (this.pending.length >= 1000) { this.dropped++; return false }
    this.pending.push(work)
    if (!this.immediate) this.immediate = setImmediate(() => this.drain())
    this.immediate?.unref()
    return true
  }

  emit(type: NotificationType, data: Record<string, unknown>): boolean {
    return this.defer(() => this.dispatch(type, data))
  }

  /** @internal Call only from deferred work; listener failures are isolated. */
  dispatch(type: NotificationType, data: Record<string, unknown>): void {
    if (this.closed) return
    const event = { id: randomUUID(), type, timestamp: Date.now(), data: redactDeep(data) }
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Notifications cannot break accounting. */ }
    }
  }

  private drain(): void {
    this.immediate = undefined
    // ponytail: fixed batches yield to generation I/O during sustained traffic.
    for (let i = 0; i < 32 && this.pending.length; i++) {
      try { this.pending.shift()!() } catch { this.dropped++ }
    }
    if (this.pending.length && !this.closed) {
      this.immediate = setImmediate(() => this.drain())
      this.immediate.unref()
    }
  }

  get queued(): number { return this.pending.length }
  close(): void {
    this.closed = true
    if (this.immediate) clearImmediate(this.immediate)
    this.pending.length = 0
    this.listeners.clear()
  }
}
