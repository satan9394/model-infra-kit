import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { Store } from "../src/store/database.js"
import { MIGRATIONS } from "../src/store/schema.js"

/**
 * EVO-G144 / ARCH-010 — Phase 1: durable outbox storage.
 *
 * The storage layer's whole promise is "a crash can never lose an accepted
 * event, and a retry can never deliver it twice". These cases pin that promise
 * at the SQL level, independent of any transport.
 */

const open: Store[] = []
afterEach(() => { for (const store of open.splice(0)) store.close() })

async function memory(): Promise<Store> {
  const store = await Store.open({ path: ":memory:" })
  open.push(store)
  return store
}

function enqueue(repository: Store["webhookOutbox"], overrides: Partial<Parameters<Store["webhookOutbox"]["enqueue"]>[0]> = {}, now = 1_000) {
  return repository.enqueue({
    id: randomUUID(), eventId: randomUUID(), destinationId: "0",
    targetUrl: "http://127.0.0.1:3219/hook", payload: '{"type":"USAGE_RECORDED"}',
    maxAttempts: 5, now, ...overrides,
  })
}

describe("EVO-G144 webhook_outbox schema", () => {
  it("adds the table additively with a v8 migration and keeps the ledger contract", async () => {
    const store = await memory()
    expect(store.schemaVersion).toBe(MIGRATIONS.length)
    expect(MIGRATIONS.some((migration) => migration.version === 8)).toBe(true)
    const columns = store.driver.prepare("PRAGMA table_info(webhook_outbox)").all().map((row) => String(row.name))
    expect(columns).toEqual(expect.arrayContaining([
      "id", "event_id", "destination_id", "target_url", "payload", "status",
      "attempts", "max_attempts", "next_retry_at", "created_at", "updated_at", "last_error",
    ]))
    // The v6/v7 integer cost authority is untouched by this migration.
    const usageColumns = store.driver.prepare("PRAGMA table_info(usage_events)").all().map((row) => String(row.name))
    expect(usageColumns).toEqual(expect.arrayContaining(["cost_micros", "cost_low_micros", "cost_high_micros", "cache_savings_micros"]))
  })

  it("rejects an unknown status, so a typo cannot create an undeliverable row", async () => {
    const store = await memory()
    expect(() => store.driver.prepare(
      "INSERT INTO webhook_outbox (id, event_id, destination_id, target_url, payload, status, attempts, max_attempts, next_retry_at, created_at, updated_at) " +
      "VALUES ('x','e','0','http://h/','{}','WAT',0,5,0,0,0)").run()).toThrow()
  })

  it("persists a queued delivery across a close/reopen cycle", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "mik-g144-")), "usage.db")
    const first = await Store.open({ path })
    expect(enqueue(first.webhookOutbox, { id: "delivery-1", eventId: "event-1" })).toBe(true)
    first.close()
    const second = await Store.open({ path })
    open.push(second)
    expect(second.schemaVersion).toBe(MIGRATIONS.length)
    expect(second.webhookOutbox.get("delivery-1")).toMatchObject({ eventId: "event-1", status: "PENDING", attempts: 0, maxAttempts: 5 })
  })
})

describe("EVO-G144 outbox repository", () => {
  it("is idempotent: replaying one delivery id never creates a second row", async () => {
    const store = await memory()
    expect(enqueue(store.webhookOutbox, { id: "stable-id" })).toBe(true)
    expect(enqueue(store.webhookOutbox, { id: "stable-id" })).toBe(false)
    expect(Number(store.driver.prepare("SELECT COUNT(*) AS n FROM webhook_outbox").get()?.n)).toBe(1)
  })

  it("collapses an at-least-once replay of the same event and destination into one row", async () => {
    const store = await memory()
    // Same event, same destination, a *different* delivery id: the unique
    // (event_id, destination_id) index keeps exactly one row.
    expect(enqueue(store.webhookOutbox, { id: "first", eventId: "same-event" })).toBe(true)
    expect(enqueue(store.webhookOutbox, { id: "second", eventId: "same-event" })).toBe(false)
    expect(store.webhookOutbox.get("first")).not.toBeNull()
    expect(store.webhookOutbox.get("second")).toBeNull()
    // A second destination is a separate delivery of the same event.
    expect(enqueue(store.webhookOutbox, { id: "third", eventId: "same-event", destinationId: "1" })).toBe(true)
  })

  it("refuses to settle a row its worker no longer owns", async () => {
    const store = await memory()
    enqueue(store.webhookOutbox, { id: "owned" }, 1_000)
    store.webhookOutbox.claimDue(1_000, 10, 0)
    // A peer's lease recovery frees the row; the stale owner must not be able to
    // roll it back out of PENDING (the "resurrect" race).
    expect(store.webhookOutbox.recoverStale(1_000, 1_100)).toBe(1)
    expect(store.webhookOutbox.get("owned")?.status).toBe("PENDING")
    store.webhookOutbox.markDelivered("owned", 1, 1_200)
    store.webhookOutbox.deadLetter("owned", 1, "HTTP 400", 1_200)
    expect(store.webhookOutbox.get("owned")?.status).toBe("PENDING")
  })

  it("claims only due rows, in order, up to the batch limit, and marks them PROCESSING", async () => {
    const store = await memory()
    enqueue(store.webhookOutbox, { id: "late" }, 1_000)
    // `next_retry_at` is set by the worker, not by enqueue: prove the due gate directly.
    store.driver.prepare("UPDATE webhook_outbox SET next_retry_at = 5000 WHERE id = 'late'").run()
    enqueue(store.webhookOutbox, { id: "due" }, 2_000)
    expect(store.webhookOutbox.claimDue(2_000, 10, 0).map((record) => record.id)).toEqual(["due"])
    expect(store.webhookOutbox.get("due")?.status).toBe("PROCESSING")
    expect(store.webhookOutbox.get("late")?.status).toBe("PENDING")
    // A second claim with an empty due set is a no-op, not a double-claim.
    expect(store.webhookOutbox.claimDue(2_000, 10, 0)).toEqual([])
    enqueue(store.webhookOutbox, { id: "a" }, 3_000)
    enqueue(store.webhookOutbox, { id: "b" }, 4_000)
    // Ordered by due time and capped by the batch limit.
    expect(store.webhookOutbox.claimDue(4_000, 1, 0).map((record) => record.id)).toEqual(["a"])
    expect(store.webhookOutbox.claimDue(4_000, 10, 0).map((record) => record.id)).toEqual(["b"])
    expect(store.webhookOutbox.claimDue(5_000, 10, 0).map((record) => record.id)).toEqual(["late"])
  })

  it("recovers a lease that a crashed process abandoned, but never steals a fresh one", async () => {
    const store = await memory()
    enqueue(store.webhookOutbox, { id: "abandoned" }, 1_000)
    enqueue(store.webhookOutbox, { id: "live" }, 1_000)
    store.webhookOutbox.claimDue(1_000, 10, 0)
    store.driver.prepare("UPDATE webhook_outbox SET updated_at = 1000 WHERE id = 'abandoned'").run()
    store.driver.prepare("UPDATE webhook_outbox SET updated_at = 9000 WHERE id = 'live'").run()
    // Lease expires at 5000: the 1000-stamp row is stale, the 9000-stamp one is not.
    const claimed = store.webhookOutbox.claimDue(9000, 10, 5000)
    expect(claimed.map((record) => record.id)).toEqual(["abandoned"])
    expect(store.webhookOutbox.get("live")?.status).toBe("PROCESSING")
  })

  it("moves a retryable failure back to PENDING with a backoff stamp and keeps the attempt count", async () => {
    const store = await memory()
    enqueue(store.webhookOutbox, { id: "retry-me" }, 1_000)
    store.webhookOutbox.claimDue(1_000, 10, 0)
    store.webhookOutbox.scheduleRetry("retry-me", 1, 3_000, "HTTP 500", 1_100)
    expect(store.webhookOutbox.get("retry-me")).toMatchObject({ status: "PENDING", attempts: 1, nextRetryAt: 3000, lastError: "HTTP 500" })
    expect(store.webhookOutbox.claimDue(2_999, 10, 0)).toEqual([])
    expect(store.webhookOutbox.claimDue(3_000, 10, 0).map((record) => record.id)).toEqual(["retry-me"])
    store.webhookOutbox.markDelivered("retry-me", 1, 3_100)
    expect(store.webhookOutbox.get("retry-me")).toMatchObject({ status: "DELIVERED", attempts: 1, lastError: null })
  })

  it("dead-letters a terminal failure, then a manual retry re-arms it from attempt zero", async () => {
    const store = await memory()
    enqueue(store.webhookOutbox, { id: "doomed" }, 1_000)
    enqueue(store.webhookOutbox, { id: "also-doomed" }, 1_000)
    store.webhookOutbox.claimDue(1_000, 10, 0)
    store.webhookOutbox.deadLetter("doomed", 5, "HTTP 404", 1_500)
    store.webhookOutbox.deadLetter("also-doomed", 5, "HTTP 400", 2_500)
    expect(store.webhookOutbox.counts()).toMatchObject({ pending: 0, processing: 0, deadLetter: 2 })
    expect(store.webhookOutbox.listDeadLetters().map((record) => record.id)).toEqual(["also-doomed", "doomed"])
    expect(store.webhookOutbox.retryDeadLetters(9_000, 10)).toBe(2)
    expect(store.webhookOutbox.get("doomed")).toMatchObject({ status: "PENDING", attempts: 0, nextRetryAt: 9_000, lastError: null })
    expect(store.webhookOutbox.counts()).toMatchObject({ pending: 2, deadLetter: 0 })
  })

  it("reports queue depth and the oldest still-undelivered event", async () => {
    const store = await memory()
    expect(store.webhookOutbox.counts()).toMatchObject({ pending: 0, processing: 0, delivered: 0, deadLetter: 0, oldestPendingAt: null })
    enqueue(store.webhookOutbox, { id: "older" }, 1_000)
    enqueue(store.webhookOutbox, { id: "newer" }, 2_000)
    store.webhookOutbox.claimDue(3_000, 1, 0)
    store.webhookOutbox.markDelivered("older", 1, 3_500)
    expect(store.webhookOutbox.counts()).toMatchObject({ pending: 1, processing: 0, delivered: 1, oldestPendingAt: 2_000 })
    expect(store.webhookOutbox.depth()).toBe(1)
  })

  it("bounds the table by pruning the oldest delivered rows and dead letters", async () => {
    const store = await memory()
    for (let i = 0; i < 5; i++) enqueue(store.webhookOutbox, { id: `d-${i}` }, 1_000 + i)
    for (let i = 0; i < 4; i++) enqueue(store.webhookOutbox, { id: `x-${i}` }, 1_000 + i)
    store.webhookOutbox.claimDue(9_000, 10, 0)
    for (let i = 0; i < 4; i++) store.webhookOutbox.deadLetter(`x-${i}`, 5, "HTTP 400", 1_000 + i)
    for (let i = 0; i < 5; i++) store.webhookOutbox.markDelivered(`d-${i}`, 1, 9_000 + i)
    expect(store.webhookOutbox.prune({ keepDelivered: 2, keepDeadLetters: 1 })).toBe(6)
    const remaining = store.driver.prepare("SELECT id FROM webhook_outbox ORDER BY id").all().map((row) => String(row.id))
    expect(remaining).toEqual(["d-3", "d-4", "x-3"])
  })
})
