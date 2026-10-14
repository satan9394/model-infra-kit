import { randomUUID } from "node:crypto"
import { redactDeep } from "../util/redact.js"
import { isForbiddenAddress } from "../util/outbound-address.js"
import type { OutboxRepository } from "../store/outbox-repository.js"
import { OutboxWorker } from "./outbox.js"
import { webhookSignature } from "./signature.js"
import { NOTIFICATION_EVENTS, NotificationBus, type NotificationEvent, type NotificationType } from "./bus.js"

export { webhookSignature, verifyWebhookSignature } from "./signature.js"

export interface WebhookConfig {
  url: string
  secret: string
  events: NotificationType[]
  timeoutMs?: number
  maxRetries?: number
  /**
   * EVO-G144 / ARCH-010: persist deliveries to `webhook_outbox` and let a
   * background worker recover them after a crash.
   *
   * This is a **dispatcher-wide mode switch**: the durable queue is one table,
   * so if any destination sets `durable: true`, every delivery for this
   * dispatcher is persisted. Defaults to `false`, which keeps the original
   * in-memory best-effort queue with no timer and no disk IO.
   */
  durable?: boolean
}

/** CLI files carry env references, never literal signing secrets. */
export function resolveWebhookConfigs(value: unknown, env: NodeJS.ProcessEnv): WebhookConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("Invalid webhook references.")
  return readWebhookConfigs(value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid webhook references.")
    const { secretRef, ...config } = item as Record<string, unknown>
    if (Object.hasOwn(config, "secret") || typeof secretRef !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(secretRef)) throw new Error("Webhook secrets require env references.")
    return { ...config, secret: env[secretRef.slice(4)] }
  }))
}

export function readWebhookConfigs(value: unknown): WebhookConfig[] {
  if (value === undefined) return []
  const invalid = () => { throw new Error("Invalid webhook configuration.") }
  if (!Array.isArray(value) || value.length > 16) return invalid()
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid()
    const config = item as WebhookConfig
    if (typeof config.url !== "string" || typeof config.secret !== "string" || !config.secret || config.secret.length > 4096
      || !Array.isArray(config.events) || !config.events.length || config.events.some(type => !NOTIFICATION_EVENTS.includes(type))) return invalid()
    let url: URL
    try { url = new URL(config.url) } catch { return invalid() }
    if (!["http:", "https:"].includes(url.protocol) || isForbiddenAddress(url.hostname)
      || url.username || url.password || url.search || url.hash || config.url.length > 2048) return invalid()
    const timeoutMs = config.timeoutMs ?? 5000, maxRetries = config.maxRetries ?? 3
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
      || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) return invalid()
    if (config.durable !== undefined && typeof config.durable !== "boolean") return invalid()
    return { url: url.href, secret: config.secret, events: [...new Set(config.events)], timeoutMs, maxRetries,
      ...(config.durable === true ? { durable: true } : {}) }
  })
}

interface Job { endpoint: number; eventId: string; type: NotificationType; body: string; attempts: number }
export interface WebhookStatus {
  closed: boolean; queued: number; active: number; retrying: number; delivered: number; dropped: number
  endpoints: Array<{ index: number; events: NotificationType[]; timeoutMs: number; maxRetries: number; durable?: true }>
  deadLetters: Array<{ endpoint: number; eventId: string; type: NotificationType; attempts: number; error: string }>
}

/**
 * EVO-G144: the queue the host is actually using. `memory` is the default
 * best-effort path; `durable` means deliveries survive a restart.
 */
export interface WebhookOutboxStats {
  mode: "durable" | "memory"
  pending: number
  processing: number
  delivered: number
  deadLetter: number
  /** Notifications refused because the queue was full or the payload was too large. */
  dropped: number
  /** Oldest still-undelivered `created_at` (durable mode), or `null` when unknown/empty. */
  oldestPendingAt: number | null
}

export interface WebhookOutboxRetryResult { mode: "durable" | "memory"; requeued: number }

/** Durable-queue wiring. Only consulted when a destination opts in with `durable: true`. */
export interface WebhookOutboxOptions {
  repository: OutboxRepository
  now?: () => number
  random?: () => number
  pollIntervalMs?: number
  batchSize?: number
  concurrency?: number
  leaseMs?: number
  baseRetryMs?: number
  maxJitterMs?: number
  /** Refuse new enqueues once `pending + processing` reaches this depth. Default 10,000. */
  maxOutboxDepth?: number
  /** Retained delivered rows / dead letters before pruning. Defaults 1,000 / 500. */
  maxDeliveredRows?: number
  maxDeadLetterRows?: number
  onWarn?: (message: string, error?: unknown) => void
}

/** Limits apply to queued jobs, retries, concurrency and payload bytes. No URLs/secrets in status. */
export class WebhookDispatcher {
  private readonly configs: WebhookConfig[]
  private readonly jobs: Job[] = []
  private readonly timers = new Map<NodeJS.Timeout, Job>()
  private readonly controllers = new Set<AbortController>()
  private readonly deadLetters: WebhookStatus["deadLetters"] = []
  private readonly unsubscribe: () => void
  private readonly outbox: WebhookOutboxOptions | undefined
  private readonly durable: boolean
  private readonly worker: OutboxWorker | undefined
  private readonly now: () => number
  private readonly maxOutboxDepth: number
  private readonly warn: (message: string, error?: unknown) => void
  private closed = false
  private outstanding = 0
  private delivered = 0
  private dropped = 0

  constructor(
    private readonly bus: NotificationBus,
    configs: unknown,
    private readonly transport: typeof fetch = globalThis.fetch,
    outbox?: WebhookOutboxOptions,
  ) {
    this.configs = readWebhookConfigs(configs)
    this.outbox = outbox
    this.now = outbox?.now ?? Date.now
    this.maxOutboxDepth = outbox?.maxOutboxDepth ?? 10_000
    this.warn = outbox?.onWarn ?? (() => {})
    // Durable mode is a dispatcher-wide switch: the queue is one table, so a
    // single opt-in persists *every* delivery. Mixing memory and durable
    // destinations would make the reported mode meaningless (and would let one
    // caller's "durable" claim hide a best-effort sibling).
    this.durable = outbox !== undefined && this.configs.some(config => config.durable === true)
    if (this.durable && outbox) {
      this.worker = new OutboxWorker({
        repository: outbox.repository,
        destination: (id) => {
          const index = Number(id)
          const config = Number.isInteger(index) ? this.configs[index] : undefined
          // The worker re-checks the URL against the row, so a removed/reordered
          // destination dead-letters instead of being dialled with stale config.
          return config ? { id, url: config.url, secret: config.secret, timeoutMs: config.timeoutMs! } : undefined
        },
        transport: this.transport,
        now: this.now,
        random: outbox.random,
        pollIntervalMs: outbox.pollIntervalMs,
        batchSize: outbox.batchSize,
        concurrency: outbox.concurrency,
        leaseMs: outbox.leaseMs,
        baseRetryMs: outbox.baseRetryMs,
        maxJitterMs: outbox.maxJitterMs,
        maxDeliveredRows: outbox.maxDeliveredRows ?? 1000,
        maxDeadLetterRows: outbox.maxDeadLetterRows ?? 500,
        onWarn: outbox.onWarn,
      })
      this.worker.start()
    }
    this.unsubscribe = bus.subscribe(event => this.enqueue(event))
  }

  private enqueue(event: NotificationEvent): void {
    if (this.closed) return
    const body = JSON.stringify(redactDeep(event), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)
    if (Buffer.byteLength(body) > 65536) { this.dropped++; return }
    for (let endpoint = 0; endpoint < this.configs.length; endpoint++) {
      const config = this.configs[endpoint]!
      if (!config.events.includes(event.type)) continue
      if (this.worker && this.outbox) {
        // Durable path: persist first, deliver later. A crash after this returns
        // still leaves a recoverable row, which is the whole point of ARCH-010.
        // A storage failure must never be silent: `dispatch` swallows listener
        // throws, so an unguarded enqueue would drop the event with the queue
        // still reading "healthy".
        try {
          if (this.durableDepth() >= this.maxOutboxDepth) { this.dropped++; continue }
          this.outbox.repository.enqueue({ id: randomUUID(), eventId: event.id, destinationId: String(endpoint),
            targetUrl: config.url, payload: body, maxAttempts: (config.maxRetries ?? 3) + 1, now: this.now() })
        } catch (error) {
          this.dropped++
          this.warn("Webhook outbox is unavailable; the notification was not persisted.", error)
        }
        continue
      }
      if (this.outstanding >= 1000) { this.dropped++; continue }
      this.outstanding++
      this.jobs.push({ endpoint, eventId: event.id, type: event.type, body, attempts: 0 })
    }
    this.pump()
  }

  private durableDepth(): number {
    return this.outbox!.repository.depth()
  }

  private pump(): void {
    while (!this.closed && this.controllers.size < 4 && this.jobs.length) void this.deliver(this.jobs.shift()!)
  }

  private async deliver(job: Job): Promise<void> {
    const config = this.configs[job.endpoint]!
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
    timeout.unref()
    job.attempts++
    let retry = false, failure: string | undefined
    try {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const response = await this.transport(config.url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", "X-Mik-Timestamp": timestamp,
          "X-Mik-Signature": webhookSignature(config.secret, timestamp, job.body) }, body: job.body })
      // Never buffer an untrusted response body or retain a live reader.
      void response.body?.cancel().catch(() => {})
      if (!response.ok) { failure = `HTTP ${response.status}`; retry = response.status >= 500 }
    } catch {
      // ponytail: generic diagnostics cannot leak arbitrary endpoint error text/credentials.
      failure = "Network failure or timeout"
      retry = true
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
    if (this.closed) return
    if (!failure) { this.delivered++; this.outstanding-- }
    else if (retry && job.attempts <= config.maxRetries!) {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.jobs.push(job)
        this.pump()
      }, 1000 * 2 ** (job.attempts - 1))
      timer.unref()
      this.timers.set(timer, job)
    } else {
      this.outstanding--
      this.deadLetters.push({ endpoint: job.endpoint, eventId: job.eventId, type: job.type, attempts: job.attempts, error: failure })
      if (this.deadLetters.length > 100) this.deadLetters.shift()
    }
    this.pump()
  }

  status(): WebhookStatus {
    return redactDeep({ closed: this.closed, queued: this.jobs.length, active: this.controllers.size, retrying: this.timers.size,
      delivered: this.delivered, dropped: this.dropped + this.bus.dropped,
      endpoints: this.configs.map((config, index) => ({ index, events: [...config.events], timeoutMs: config.timeoutMs!, maxRetries: config.maxRetries!,
        ...(this.worker ? { durable: true as const } : {}) })),
      deadLetters: this.deadLetters.map(entry => ({ ...entry })) })
  }

  /** EVO-G144: queue depth for the mode this host is actually running in. */
  outboxStats(): WebhookOutboxStats {
    if (this.worker && this.outbox) {
      const counts = this.outbox.repository.counts()
      return { mode: "durable", pending: counts.pending, processing: counts.processing,
        delivered: counts.delivered, deadLetter: counts.deadLetter, dropped: this.dropped + this.bus.dropped, oldestPendingAt: counts.oldestPendingAt }
    }
    return { mode: "memory", pending: this.jobs.length + this.timers.size, processing: this.controllers.size,
      delivered: this.delivered, deadLetter: this.deadLetters.length, dropped: this.dropped + this.bus.dropped, oldestPendingAt: null }
  }

  /** True when deliveries are persisted (any destination opted in). */
  get durableMode(): boolean { return this.worker !== undefined }

  /**
   * Re-arm dead letters. Only a durable queue can do this: the in-memory queue
   * keeps failures for diagnostics and has nothing persisted to retry, so it
   * reports `mode: "memory"` and requeues nothing rather than pretending.
   */
  retryDeadOutbox(): WebhookOutboxRetryResult {
    if (this.worker && this.outbox) return { mode: "durable", requeued: this.outbox.repository.retryDeadLetters(this.now(), 1000) }
    return { mode: "memory", requeued: 0 }
  }

  test(): boolean { return !this.closed && this.bus.emit("USAGE_RECORDED", { test: true, costMicros: 0n, cacheSavingsMicros: 0n }) }

  close(): void {
    this.closed = true
    this.unsubscribe()
    this.worker?.close()
    for (const timer of this.timers.keys()) clearTimeout(timer)
    this.timers.clear()
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.jobs.length = 0
    this.outstanding = 0
  }
}
