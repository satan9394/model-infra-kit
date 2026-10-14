import type { StorageAdapter } from "./adapter.js"
import { asNumber, asString } from "./driver.js"

/** Terminal and in-flight states of one durable delivery. Enforced by a CHECK constraint. */
export type OutboxStatus = "PENDING" | "PROCESSING" | "DELIVERED" | "DEAD_LETTER"

export const OUTBOX_STATUSES: readonly OutboxStatus[] = ["PENDING", "PROCESSING", "DELIVERED", "DEAD_LETTER"]

/** One persisted delivery attempt chain. `payload` is already redacted wire bytes. */
export interface OutboxRecord {
  id: string
  eventId: string
  destinationId: string
  targetUrl: string
  payload: string
  status: OutboxStatus
  attempts: number
  maxAttempts: number
  nextRetryAt: number
  createdAt: number
  updatedAt: number
  lastError: string | null
}

export interface OutboxCounts {
  pending: number
  processing: number
  delivered: number
  deadLetter: number
  /** Oldest still-undelivered `created_at`, or `null` when the queue is empty. */
  oldestPendingAt: number | null
}

export interface EnqueueInput {
  id: string
  eventId: string
  destinationId: string
  targetUrl: string
  payload: string
  maxAttempts: number
  now: number
}

/**
 * Durable webhook queue (EVO-G144 / ARCH-010).
 *
 * This repository is deliberately dumb: it only moves rows between the four
 * states and never signs, sends or logs a payload. It is also the *only* place
 * that knows the table shape, so the worker stays transport-focused.
 *
 * All mutations for one logical step run inside a single synchronous
 * transaction, so a crash can never leave a row half-claimed: either it is
 * `PROCESSING` with a fresh `updated_at`, or it is untouched.
 */
export class OutboxRepository {
  constructor(private readonly driver: StorageAdapter) {}

  /**
   * Insert one delivery.
   *
   * `INSERT OR IGNORE` is a real idempotency guard at the `(event_id,
   * destination_id)` grain: replaying the *same* event to the same destination
   * — a retried enqueue, or a replay of one that already committed — can never
   * create a second row. The caller still mints a fresh delivery id per accept,
   * so this dedupes at-least-once *enqueues*, not distinct events.
   */
  enqueue(input: EnqueueInput): boolean {
    const result = this.driver
      .prepare(
        `INSERT OR IGNORE INTO webhook_outbox
           (id, event_id, destination_id, target_url, payload, status, attempts, max_attempts, next_retry_at, created_at, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?, NULL)`,
      )
      .run(input.id, input.eventId, input.destinationId, input.targetUrl, input.payload, input.maxAttempts, input.now, input.now, input.now)
    return Number(result.changes) > 0
  }

  /** Undelivered depth (`PENDING` + `PROCESSING`), index-assisted for the enqueue hot path. */
  depth(): number {
    const row = this.driver.prepare("SELECT COUNT(*) AS n FROM webhook_outbox WHERE status IN ('PENDING', 'PROCESSING')").get()
    return row ? asNumber(row.n) : 0
  }

  /** Reset every lease older than `staleBefore`; returns how many were recovered. */
  recoverStale(staleBefore: number, now: number): number {
    return Number(
      this.driver
        .prepare("UPDATE webhook_outbox SET status = 'PENDING', updated_at = ? WHERE status = 'PROCESSING' AND updated_at <= ?")
        .run(now, staleBefore).changes,
    )
  }

  /**
   * Claim up to `limit` due rows for this worker, recovering abandoned work in
   * the same transaction.
   *
   * `staleBefore` resets any `PROCESSING` row whose last touch is older than the
   * lease — that row belongs to a process that died mid-delivery. Recovery happens
   * here (not only at startup) so a crashed peer is picked up by a live worker
   * without waiting for a restart.
   */
  claimDue(now: number, limit: number, staleBefore: number): OutboxRecord[] {
    if (!Number.isInteger(limit) || limit <= 0) return []
    return this.driver.transaction(() => {
      this.recoverStale(staleBefore, now)
      const due = this.driver
        .prepare("SELECT id FROM webhook_outbox WHERE status = 'PENDING' AND next_retry_at <= ? ORDER BY next_retry_at ASC, created_at ASC LIMIT ?")
        .all(now, limit)
        .map((row) => asString(row.id))
        .filter((id) => id.length > 0)
      if (due.length === 0) return []
      const placeholders = due.map(() => "?").join(", ")
      this.driver
        .prepare(`UPDATE webhook_outbox SET status = 'PROCESSING', updated_at = ? WHERE id IN (${placeholders})`)
        .run(now, ...due)
      return this.driver
        .prepare(`SELECT * FROM webhook_outbox WHERE id IN (${placeholders})`)
        .all(...due)
        .map(toRecord)
    })
  }

  /**
   * Terminal success. `attempts` records the total attempts the delivery took.
   *
   * The `status = 'PROCESSING'` fence means only the worker that currently owns
   * the lease can settle the row: a stale in-flight worker whose lease was
   * recovered by a peer cannot flip an already-`DELIVERED` row back to
   * `PENDING`/`DEAD_LETTER` (the "resurrect" race). Duplicate delivery is still
   * possible under at-least-once — but never a state rollback.
   */
  markDelivered(id: string, attempts: number, now: number): void {
    this.driver
      .prepare("UPDATE webhook_outbox SET status = 'DELIVERED', attempts = ?, updated_at = ?, last_error = NULL WHERE id = ? AND status = 'PROCESSING'")
      .run(attempts, now, id)
  }

  /** Back off and re-arm a retryable failure. `attempts` is the count *after* this attempt. */
  scheduleRetry(id: string, attempts: number, nextRetryAt: number, error: string, now: number): void {
    this.driver
      .prepare("UPDATE webhook_outbox SET status = 'PENDING', attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING'")
      .run(attempts, nextRetryAt, error, now, id)
  }

  /** Terminal failure: keeps the row for diagnostics but stops the retry chain. */
  deadLetter(id: string, attempts: number, error: string, now: number): void {
    this.driver
      .prepare("UPDATE webhook_outbox SET status = 'DEAD_LETTER', attempts = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'PROCESSING'")
      .run(attempts, error, now, id)
  }

  get(id: string): OutboxRecord | null {
    const row = this.driver.prepare("SELECT * FROM webhook_outbox WHERE id = ?").get(id)
    return row ? toRecord(row) : null
  }

  counts(): OutboxCounts {
    const rows = this.driver.prepare("SELECT status AS status, COUNT(*) AS n FROM webhook_outbox GROUP BY status").all()
    const counts: OutboxCounts = { pending: 0, processing: 0, delivered: 0, deadLetter: 0, oldestPendingAt: null }
    for (const row of rows) {
      const total = asNumber(row.n)
      switch (asString(row.status)) {
        case "PENDING": counts.pending = total; break
        case "PROCESSING": counts.processing = total; break
        case "DELIVERED": counts.delivered = total; break
        case "DEAD_LETTER": counts.deadLetter = total; break
        default: break
      }
    }
    const oldest = this.driver
      .prepare("SELECT MIN(created_at) AS oldest FROM webhook_outbox WHERE status IN ('PENDING', 'PROCESSING')")
      .get()
    const value = oldest ? asNumber(oldest.oldest, Number.NaN) : Number.NaN
    counts.oldestPendingAt = Number.isFinite(value) ? value : null
    return counts
  }

  listDeadLetters(limit = 100): OutboxRecord[] {
    return this.driver
      .prepare("SELECT * FROM webhook_outbox WHERE status = 'DEAD_LETTER' ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map(toRecord)
  }

  /** Manual operator action: re-arm every dead letter (oldest first) from attempt zero. */
  retryDeadLetters(now: number, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0
    return this.driver.transaction(() => {
      const ids = this.driver
        .prepare("SELECT id FROM webhook_outbox WHERE status = 'DEAD_LETTER' ORDER BY updated_at ASC LIMIT ?")
        .all(limit)
        .map((row) => asString(row.id))
        .filter((id) => id.length > 0)
      if (ids.length === 0) return 0
      const placeholders = ids.map(() => "?").join(", ")
      const result = this.driver
        .prepare(`UPDATE webhook_outbox SET status = 'PENDING', attempts = 0, next_retry_at = ?, last_error = NULL, updated_at = ? WHERE id IN (${placeholders})`)
        .run(now, now, ...ids)
      return Number(result.changes)
    })
  }

  /** Bound the table: keep the newest `keepDelivered` deliveries and `keepDeadLetters` failures. */
  prune(options: { keepDelivered?: number; keepDeadLetters?: number }): number {
    const limits: Array<[OutboxStatus, number]> = []
    if (options.keepDelivered !== undefined) limits.push(["DELIVERED", Math.max(0, Math.trunc(options.keepDelivered))])
    if (options.keepDeadLetters !== undefined) limits.push(["DEAD_LETTER", Math.max(0, Math.trunc(options.keepDeadLetters))])
    return this.driver.transaction(() => {
      let removed = 0
      for (const [status, keep] of limits) {
        const result = this.driver
          .prepare(
            `DELETE FROM webhook_outbox WHERE status = ? AND id NOT IN (
               SELECT id FROM webhook_outbox WHERE status = ? ORDER BY updated_at DESC LIMIT ?)`,
          )
          .run(status, status, keep)
        removed += Number(result.changes)
      }
      return removed
    })
  }
}

function toRecord(row: Record<string, unknown>): OutboxRecord {
  return {
    id: asString(row.id),
    eventId: asString(row.event_id),
    destinationId: asString(row.destination_id),
    targetUrl: asString(row.target_url),
    payload: asString(row.payload),
    status: asString(row.status) as OutboxStatus,
    attempts: asNumber(row.attempts),
    maxAttempts: asNumber(row.max_attempts),
    nextRetryAt: asNumber(row.next_retry_at),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : asString(row.last_error),
  }
}
