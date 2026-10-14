import { redact } from "../util/redact.js"
import type { OutboxRecord, OutboxRepository } from "../store/outbox-repository.js"
import { webhookSignature } from "./signature.js"

/** A resolved destination. The secret lives here and in the config only, never in SQLite. */
export interface OutboxDestination {
  id: string
  url: string
  secret: string
  timeoutMs: number
}

export interface OutboxWorkerOptions {
  repository: OutboxRepository
  /** Resolve the destination stored on a row. Secrets stay process-local. */
  destination: (id: string) => OutboxDestination | undefined
  transport?: typeof fetch
  now?: () => number
  random?: () => number
  /** Delay between poll cycles. Default 1000ms. */
  pollIntervalMs?: number
  /** Rows claimed per cycle. Bounds both query size and memory. Default 25. */
  batchSize?: number
  /** Parallel deliveries inside one batch. Default 4. */
  concurrency?: number
  /** A `PROCESSING` row untouched this long belonged to a dead process. Default 60s. */
  leaseMs?: number
  /** First retry delay; doubles per attempt. Default 1000ms. */
  baseRetryMs?: number
  /** Ceiling for the exponential backoff. Default 300s. */
  maxRetryMs?: number
  /** Upper bound of the random jitter added to each retry. Default 250ms. */
  maxJitterMs?: number
  /** Retained delivered rows before pruning. `undefined` disables that prune. */
  maxDeliveredRows?: number
  /** Retained dead letters before pruning. `undefined` disables that prune. */
  maxDeadLetterRows?: number
  /** Minimum gap between prunes. Default 60s; `0` prunes every cycle. */
  pruneIntervalMs?: number
  onWarn?: (message: string, error?: unknown) => void
}

/**
 * Durable webhook delivery worker (EVO-G144 / ARCH-010).
 *
 * Started only when a host opts in with `webhook.durable`, so an embedded host
 * that never asked for it pays no timer and no disk IO. The worker:
 *
 * 1. recovers abandoned leases at startup and on every cycle (`recoverStale`),
 * 2. claims a bounded batch of due rows and flips them to `PROCESSING` in one
 *    transaction, so a crash at any point leaves a *recoverable* row,
 * 3. signs and sends each row with a **stable** `X-Mik-Delivery-Id`/`X-Mik-Event-Id`
 *    pair, so a receiver can dedupe redeliveries,
 * 4. backs off with jitter, then dead-letters, and periodically prunes.
 *
 * `start()` is idempotent: one worker instance owns at most one timer, which is
 * what keeps a single process from double-claiming its own rows.
 */
export class OutboxWorker {
  private readonly repository: OutboxRepository
  private readonly destination: (id: string) => OutboxDestination | undefined
  private readonly transport: typeof fetch
  private readonly now: () => number
  private readonly random: () => number
  private readonly pollIntervalMs: number
  private readonly batchSize: number
  private readonly concurrency: number
  private readonly leaseMs: number
  private readonly baseRetryMs: number
  private readonly maxRetryMs: number
  private readonly maxJitterMs: number
  private readonly maxDeliveredRows: number | undefined
  private readonly maxDeadLetterRows: number | undefined
  private readonly pruneIntervalMs: number
  private readonly onWarn: (message: string, error?: unknown) => void
  private readonly controllers = new Set<AbortController>()
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private started = false
  private ticking = false
  private lastPruneAt = Number.NEGATIVE_INFINITY

  constructor(options: OutboxWorkerOptions) {
    this.repository = options.repository
    this.destination = options.destination
    this.transport = options.transport ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
    this.batchSize = options.batchSize ?? 25
    this.concurrency = Math.max(1, options.concurrency ?? 4)
    this.leaseMs = options.leaseMs ?? 60_000
    this.baseRetryMs = options.baseRetryMs ?? 1000
    this.maxRetryMs = options.maxRetryMs ?? 300_000
    this.maxJitterMs = options.maxJitterMs ?? 250
    this.maxDeliveredRows = options.maxDeliveredRows
    this.maxDeadLetterRows = options.maxDeadLetterRows
    this.pruneIntervalMs = options.pruneIntervalMs ?? 60_000
    this.onWarn = options.onWarn ?? (() => {})
  }

  /** Idempotent; recovers first so work left by a dead process is picked up immediately. */
  start(): void {
    if (this.started || this.closed) return
    this.started = true
    try {
      this.recover()
    } catch (error) {
      this.onWarn("Webhook outbox recovery failed.", error)
    }
    this.schedule(0)
  }

  /** Reset leases abandoned by a crashed process; returns how many were recovered. */
  recover(): number {
    const now = this.now()
    return this.repository.recoverStale(now - this.leaseMs, now)
  }

  /**
   * One poll cycle: claim a batch, deliver it, prune if due. Exposed so a test
   * can drive the worker without timers.
   */
  async drain(): Promise<number> {
    if (this.closed) return 0
    const now = this.now()
    const records = this.repository.claimDue(now, this.batchSize, now - this.leaseMs)
    if (records.length === 0) {
      this.maybePrune(now)
      return 0
    }
    await this.runBatch(records)
    this.maybePrune(this.now())
    return records.length
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }

  private schedule(delayMs: number): void {
    if (this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, delayMs)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    if (this.closed || this.ticking) {
      this.schedule(this.pollIntervalMs)
      return
    }
    this.ticking = true
    try {
      await this.drain()
    } catch (error) {
      this.onWarn("Webhook outbox poll failed.", error)
    } finally {
      this.ticking = false
    }
    this.schedule(this.pollIntervalMs)
  }

  private async runBatch(records: OutboxRecord[]): Promise<void> {
    let index = 0
    const lanes = Math.min(this.concurrency, records.length)
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        while (index < records.length && !this.closed) {
          const record = records[index]!
          index += 1
          await this.deliver(record)
        }
      }),
    )
  }

  private async deliver(record: OutboxRecord): Promise<void> {
    const destination = this.destination(record.destinationId)
    const attempts = record.attempts + 1
    if (!destination || destination.url !== record.targetUrl) {
      // Config drift (a destination was removed or reordered). Never send to a
      // different URL than the one the host accepted the event for.
      this.repository.deadLetter(record.id, attempts, "Destination is no longer configured", this.now())
      return
    }

    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), destination.timeoutMs)
    timeout.unref()
    let failure: string | undefined
    let retryable = false
    try {
      const timestamp = String(Math.floor(this.now() / 1000))
      const response = await this.transport(destination.url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "X-Mik-Timestamp": timestamp,
          "X-Mik-Signature": webhookSignature(destination.secret, timestamp, record.payload),
          // Stable across every retry of this row: the receiver dedupes on it.
          "X-Mik-Delivery-Id": record.id,
          "X-Mik-Event-Id": record.eventId,
        },
        body: record.payload,
      })
      // Never buffer an untrusted response body or retain a live reader.
      void response.body?.cancel().catch(() => {})
      if (!response.ok) {
        failure = `HTTP ${response.status}`
        // Same contract as the in-memory queue (docs/interfaces.md): 5xx is
        // retryable, every 4xx — including 429 — is a terminal rejection.
        retryable = response.status >= 500
      }
    } catch {
      // ponytail: generic diagnostics cannot leak arbitrary endpoint error text/credentials.
      failure = "Network failure or timeout"
      retryable = true
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }

    if (this.closed) return
    const at = this.now()
    if (!failure) {
      this.repository.markDelivered(record.id, attempts, at)
      return
    }
    if (retryable && attempts < record.maxAttempts) {
      this.repository.scheduleRetry(record.id, attempts, at + this.backoffMs(attempts), redact(failure), at)
    } else {
      this.repository.deadLetter(record.id, attempts, redact(failure), at)
    }
  }

  private backoffMs(attempts: number): number {
    const exponential = Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** Math.max(0, attempts - 1))
    return exponential + Math.floor(this.random() * this.maxJitterMs)
  }

  private maybePrune(now: number): void {
    if (this.maxDeliveredRows === undefined && this.maxDeadLetterRows === undefined) return
    if (now - this.lastPruneAt < this.pruneIntervalMs) return
    this.lastPruneAt = now
    this.repository.prune({ keepDelivered: this.maxDeliveredRows, keepDeadLetters: this.maxDeadLetterRows })
  }
}
