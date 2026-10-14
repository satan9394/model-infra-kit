import { createServer as httpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Store } from "../src/store/database.js"
import { OutboxWorker, type OutboxDestination } from "../src/events/outbox.js"
import { NotificationBus, NOTIFICATION_EVENTS } from "../src/events/bus.js"
import { WebhookDispatcher } from "../src/events/webhook.js"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/server.js"

/**
 * EVO-G144 / ARCH-010 — Phase 2: durable delivery with crash recovery.
 *
 * The DoD is "kill the process right after the event is committed, restart, and
 * the event still goes out". These cases therefore reopen the database to model
 * a real restart, rather than only poking in-memory state.
 */

const open: Store[] = []
const workers: OutboxWorker[] = []
const dispatchers: WebhookDispatcher[] = []
afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.close()
  for (const worker of workers.splice(0)) worker.close()
  for (const store of open.splice(0)) store.close()
  vi.useRealTimers()
})

const HOOK = "http://127.0.0.1:3219/hook"
const hookConfig = (overrides: Record<string, unknown> = {}) => ({ url: HOOK, secret: "plain-signing-secret", events: [...NOTIFICATION_EVENTS], ...overrides })

async function flush(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

async function memory(): Promise<Store> {
  const store = await Store.open({ path: ":memory:" })
  open.push(store)
  return store
}

const DESTINATION: OutboxDestination = { id: "0", url: "http://127.0.0.1:3219/hook", secret: "plain-signing-secret", timeoutMs: 5_000 }

function workerFor(store: Store, transport: typeof fetch, overrides: Partial<ConstructorParameters<typeof OutboxWorker>[0]> = {}) {
  const worker = new OutboxWorker({
    repository: store.webhookOutbox,
    destination: (id) => (id === DESTINATION.id ? DESTINATION : undefined),
    transport,
    now: overrides.now ?? (() => 1_000_000),
    random: () => 0,
    baseRetryMs: 1_000,
    maxJitterMs: 0,
    leaseMs: 60_000,
    ...overrides,
  })
  workers.push(worker)
  return worker
}

function seed(store: Store, overrides: Partial<Parameters<Store["webhookOutbox"]["enqueue"]>[0]> = {}) {
  return store.webhookOutbox.enqueue({
    id: "delivery-1", eventId: "event-1", destinationId: "0", targetUrl: DESTINATION.url,
    payload: '{"type":"USAGE_RECORDED","data":{"costMicros":"3"}}', maxAttempts: 5, now: 1_000_000, ...overrides,
  })
}

describe("EVO-G144 durable outbox worker", () => {
  it("delivers an event that was persisted before the process died, on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mik-g144w-"))
    const db = join(dir, "usage.db")
    const first = await Store.open({ path: db })
    seed(first)                                   // committed to the outbox…
    first.close()                                 // …then the process is killed before any send

    const second = await Store.open({ path: db })
    open.push(second)
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const worker = workerFor(second, transport)
    expect(await worker.drain()).toBe(1)
    expect(transport).toHaveBeenCalledTimes(1)
    const [url, init] = transport.mock.calls[0]!
    const headers = init!.headers as Record<string, string>
    expect(url).toBe(DESTINATION.url)
    expect(headers["X-Mik-Delivery-Id"]).toBe("delivery-1")
    expect(headers["X-Mik-Event-Id"]).toBe("event-1")
    expect(second.webhookOutbox.get("delivery-1")).toMatchObject({ status: "DELIVERED", attempts: 1 })
  })

  it("recovers a PROCESSING row abandoned by a crash mid-delivery and finishes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mik-g144w-"))
    const db = join(dir, "usage.db")
    const first = await Store.open({ path: db })
    seed(first)
    first.webhookOutbox.claimDue(1_000_000, 10, 0)   // claimed, then the process dies before sending
    expect(first.webhookOutbox.get("delivery-1")?.status).toBe("PROCESSING")
    first.close()

    const second = await Store.open({ path: db })
    open.push(second)
    let clock = 1_000_000
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const worker = workerFor(second, transport, { now: () => clock })
    // Before the lease expires the row is still owned by the "dead" process.
    expect(await worker.drain()).toBe(0)
    clock += 60_001
    expect(worker.recover()).toBe(1)
    expect(second.webhookOutbox.get("delivery-1")?.status).toBe("PENDING")
    expect(await worker.drain()).toBe(1)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(second.webhookOutbox.get("delivery-1")).toMatchObject({ status: "DELIVERED", attempts: 1 })
  })

  it("retries a 5xx with the same delivery id after a jittered backoff", async () => {
    const store = await memory()
    seed(store)
    let clock = 1_000_000
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const worker = workerFor(store, transport, { now: () => clock })
    expect(await worker.drain()).toBe(1)
    expect(store.webhookOutbox.get("delivery-1")).toMatchObject({ status: "PENDING", attempts: 1, lastError: "HTTP 500" })
    // Not due until the backoff elapses.
    expect(await worker.drain()).toBe(0)
    clock += 1_000
    expect(await worker.drain()).toBe(1)
    const first = transport.mock.calls[0]![1]!.headers as Record<string, string>
    const second = transport.mock.calls[1]![1]!.headers as Record<string, string>
    expect(first["X-Mik-Delivery-Id"]).toBe(second["X-Mik-Delivery-Id"])
    expect(store.webhookOutbox.get("delivery-1")).toMatchObject({ status: "DELIVERED", attempts: 2 })
  })

  it("dead-letters after the attempt budget and can be re-armed by an operator", async () => {
    const store = await memory()
    seed(store, { maxAttempts: 2 })
    let clock = 1_000_000
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    const worker = workerFor(store, transport, { now: () => clock })
    expect(await worker.drain()).toBe(1)
    clock += 1_000
    expect(await worker.drain()).toBe(1)
    expect(store.webhookOutbox.get("delivery-1")).toMatchObject({ status: "DEAD_LETTER", attempts: 2, lastError: "HTTP 503" })
    expect(await worker.drain()).toBe(0)
    expect(store.webhookOutbox.retryDeadLetters(clock, 10)).toBe(1)
    transport.mockResolvedValue(new Response(null, { status: 204 }))
    expect(await worker.drain()).toBe(1)
    expect(store.webhookOutbox.get("delivery-1")).toMatchObject({ status: "DELIVERED", attempts: 1 })
  })

  it("dead-letters a 4xx immediately instead of retrying a permanent rejection", async () => {
    const store = await memory()
    seed(store)
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }))
    const worker = workerFor(store, transport)
    expect(await worker.drain()).toBe(1)
    expect(store.webhookOutbox.get("delivery-1")).toMatchObject({ status: "DEAD_LETTER", attempts: 1, lastError: "HTTP 403" })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it("treats 429 as a terminal 4xx, exactly like the in-memory queue and docs/interfaces.md", async () => {
    const store = await memory()
    seed(store)
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }))
    const worker = workerFor(store, transport)
    expect(await worker.drain()).toBe(1)
    expect(store.webhookOutbox.get("delivery-1")).toMatchObject({ status: "DEAD_LETTER", attempts: 1, lastError: "HTTP 429" })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it("never sends to a URL the host no longer maps, and never leaks endpoint error text", async () => {
    const store = await memory()
    seed(store)
    const transport = vi.fn<typeof fetch>()
    const drifted = new OutboxWorker({ repository: store.webhookOutbox, destination: () => undefined, transport, now: () => 1_000_000 })
    workers.push(drifted)
    expect(await drifted.drain()).toBe(1)
    expect(transport).not.toHaveBeenCalled()
    expect(store.webhookOutbox.get("delivery-1")).toMatchObject({ status: "DEAD_LETTER", lastError: "Destination is no longer configured" })

    seed(store, { id: "delivery-2", eventId: "event-2" })
    const leaky = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused: token=raw-secret sk-abcdef"))
    const worker = workerFor(store, leaky)
    await worker.drain()
    const stored = store.webhookOutbox.get("delivery-2")!
    expect(stored.lastError).toBe("Network failure or timeout")
    expect(JSON.stringify(stored)).not.toContain("raw-secret")
    expect(JSON.stringify(stored)).not.toContain("sk-abcdef")
  })

  it("does not double-send a row while its delivery is still in flight", async () => {
    vi.useFakeTimers()
    const store = await memory()
    seed(store)
    let release: (() => void) | undefined
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(null, { status: 204 }))
    }))
    const worker = workerFor(store, transport, { now: Date.now, pollIntervalMs: 100, leaseMs: 60_000 })
    worker.start()
    await vi.advanceTimersByTimeAsync(10_000)     // many poll cycles while the POST hangs
    expect(transport).toHaveBeenCalledTimes(1)
    release!()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.webhookOutbox.get("delivery-1")?.status).toBe("DELIVERED")
    expect(transport).toHaveBeenCalledTimes(1)
    worker.close()
  })

  it("start() registers exactly one poll loop, however often it is called", async () => {
    vi.useFakeTimers()
    const store = await memory()
    seed(store)
    const worker = workerFor(store, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })), { now: Date.now, pollIntervalMs: 100 })
    const spy = vi.spyOn(globalThis, "setTimeout")
    worker.start()
    worker.start()
    worker.start()
    // A missing `started` guard would arm one timer per call. `ticking` alone
    // would not catch it, so this asserts the guard and not an accident.
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    worker.close()
  })

  it("close() aborts in-flight work without losing the row, and a later worker resumes it", async () => {
    vi.useFakeTimers()
    const store = await memory()
    seed(store)
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
    const worker = workerFor(store, transport, { now: Date.now, pollIntervalMs: 100 })
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport).toHaveBeenCalledTimes(1)
    worker.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(store.webhookOutbox.get("delivery-1")?.status).toBe("PROCESSING")
    // A later worker with an expired lease picks the abandoned row back up.
    const clock = Date.now() + 120_000
    const resumed = workerFor(store, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })), { now: () => clock })
    expect(await resumed.drain()).toBe(1)
    expect(store.webhookOutbox.get("delivery-1")?.status).toBe("DELIVERED")
  })

  it("reports durable queue depth including the oldest undelivered event", async () => {
    const store = await memory()
    seed(store, { id: "a", eventId: "event-a", now: 1_000 })
    seed(store, { id: "b", eventId: "event-b", now: 2_000 })
    const worker = workerFor(store, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })))
    await worker.drain()
    const counts = store.webhookOutbox.counts()
    expect(counts).toMatchObject({ pending: 2, processing: 0, delivered: 0, deadLetter: 0, oldestPendingAt: 1_000 })
  })
})

describe("EVO-G144 durable outbox is opt-in", () => {
  it("keeps the memory queue and writes nothing to disk when durable is not set", async () => {
    const store = await memory()
    const bus = new NotificationBus()
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const dispatcher = new WebhookDispatcher(bus, [hookConfig()], transport, { repository: store.webhookOutbox, onWarn: () => {} })
    dispatchers.push(dispatcher)
    bus.emit("USAGE_RECORDED", {})
    await flush()
    expect(dispatcher.outboxStats()).toMatchObject({ mode: "memory", pending: 0 })
    expect(dispatcher.retryDeadOutbox()).toEqual({ mode: "memory", requeued: 0 })
    expect(store.webhookOutbox.counts()).toMatchObject({ pending: 0, processing: 0, delivered: 0, deadLetter: 0 })
    await waitFor(() => transport.mock.calls.length === 1)
    bus.close()
  })

  it("persists a redacted payload before delivery and sends stable delivery headers", async () => {
    const store = await memory()
    const bus = new NotificationBus()
    let release: (() => void) | undefined
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { release = () => resolve(new Response(null, { status: 204 })) }))
    const dispatcher = new WebhookDispatcher(bus, [hookConfig({ durable: true })], transport,
      { repository: store.webhookOutbox, onWarn: () => {}, pollIntervalMs: 20, now: () => 1_000_000, random: () => 0 })
    dispatchers.push(dispatcher)
    bus.emit("USAGE_RECORDED", { api_key: "plain-key", token: "request-secret" })
    await waitFor(() => transport.mock.calls.length === 1)
    const rows = store.driver.prepare("SELECT id FROM webhook_outbox").all()
    expect(rows).toHaveLength(1)
    const row = store.webhookOutbox.get(String(rows[0]!.id))!
    // The persisted bytes are already redacted: no plaintext credential on disk.
    expect(row.payload).not.toContain("plain-key")
    expect(row.payload).not.toContain("request-secret")
    expect(row.payload).toContain("[REDACTED]")
    expect(row).toMatchObject({ destinationId: "0", targetUrl: HOOK, status: "PROCESSING", attempts: 0 })
    const headers = transport.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers["X-Mik-Delivery-Id"]).toBe(row.id)
    expect(headers["X-Mik-Event-Id"]).toBe(row.eventId)
    const stats = dispatcher.outboxStats()
    expect(stats.mode).toBe("durable")
    expect(stats.pending + stats.processing).toBe(1)
    release!()
    await waitFor(() => store.webhookOutbox.get(row.id)?.status === "DELIVERED")
    expect(store.webhookOutbox.get(row.id)?.attempts).toBe(1)
    bus.close()
  })

  it("counts and warns when the durable store rejects an enqueue instead of losing it silently", async () => {
    const store = await memory()
    const bus = new NotificationBus()
    const warnings: string[] = []
    const dispatcher = new WebhookDispatcher(bus, [hookConfig({ durable: true })], vi.fn<typeof fetch>(),
      { repository: store.webhookOutbox, onWarn: (message) => warnings.push(message), pollIntervalMs: 20, now: () => 1_000_000 })
    dispatchers.push(dispatcher)
    // Only the INSERT fails: reads (and therefore the stats endpoint) still work,
    // so a swallowed failure would look like a healthy empty queue.
    store.driver.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON webhook_outbox BEGIN SELECT RAISE(ABORT, 'insert rejected'); END")
    bus.emit("USAGE_RECORDED", {})
    await flush()
    expect(dispatcher.outboxStats()).toMatchObject({ mode: "durable", pending: 0, processing: 0, dropped: 1 })
    expect(warnings.some((message) => /not persisted/.test(message))).toBe(true)
    expect(store.webhookOutbox.counts()).toMatchObject({ pending: 0, delivered: 0 })
    bus.close()
  })

  it("treats one opt-in as dispatcher-wide durable mode, so no destination is silently best-effort", async () => {
    const store = await memory()
    const bus = new NotificationBus()
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const dispatcher = new WebhookDispatcher(bus, [hookConfig({ durable: true }), hookConfig({ url: "http://127.0.0.1:3220/hook" })], transport,
      { repository: store.webhookOutbox, onWarn: () => {}, pollIntervalMs: 20, now: () => 1_000_000, random: () => 0 })
    dispatchers.push(dispatcher)
    bus.emit("USAGE_RECORDED", {})
    await waitFor(() => store.webhookOutbox.counts().delivered === 2)
    expect(store.webhookOutbox.counts()).toMatchObject({ pending: 0, processing: 0, delivered: 2, deadLetter: 0 })
    const destinations = store.driver.prepare("SELECT DISTINCT destination_id AS d FROM webhook_outbox ORDER BY d").all().map((row) => String(row.d))
    expect(destinations).toEqual(["0", "1"])
    expect(dispatcher.status().endpoints.map((endpoint) => endpoint.durable)).toEqual([true, true])
    bus.close()
  })

  it("persists the notification before record() returns, so a crash right after the ledger commit can still resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mik-g144w-"))
    const db = join(dir, "usage.db")
    const inspector = await Store.open({ path: db })
    const hub = await ModelInfra.init({ appId: "app", db, cache: false, syncCatalog: false, pricingAutoSync: false,
      pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {},
      webhooks: [hookConfig({ timeoutMs: 100, maxRetries: 0, durable: true })] })
    let persistedEventId = ""
    try {
      expect(hub.webhooks.durableMode).toBe(true)
      hub.usage.record({ requestId: "crash-1", appId: "app", ts: 1_000, source: "embedded", providerId: "p",
        modelRequested: "p:m", modelActual: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: { usd: 0.000001, low: 0.000001, high: 0.000001, source: "manual", basis: "flat" }, status: "ok", isStreaming: false })
      // NO await since record(): the row must already be committed, or a kill
      // here would drop the notification (the deferred-queue failure mode).
      const rows = inspector.driver.prepare("SELECT status, attempts, event_id FROM webhook_outbox").all()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: "PENDING", attempts: 0 })
      persistedEventId = String(rows[0]!.event_id)
      hub.webhooks.close()   // "kill" the worker before its first poll can fire
      expect(inspector.driver.prepare("SELECT status FROM webhook_outbox").get()).toMatchObject({ status: "PENDING" })
    } finally {
      await hub.close()
    }
    inspector.close()

    // Restart: a fresh process recovers the row and delivers it. The hub stamps
    // `next_retry_at` with the real clock, so the resumed worker uses it too.
    const restarted = await Store.open({ path: db })
    open.push(restarted)
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const worker = workerFor(restarted, transport, { now: () => Date.now() })
    expect(await worker.drain()).toBe(1)
    expect(transport).toHaveBeenCalledTimes(1)
    const headers = transport.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers["X-Mik-Event-Id"]).toBe(persistedEventId)
    const deliveryId = headers["X-Mik-Delivery-Id"]!
    expect(restarted.webhookOutbox.get(deliveryId)?.status).toBe("DELIVERED")
  })

  it("exposes queue depth and genuinely re-delivers dead letters over the admin API", async () => {
    // A real receiver that rejects first, then accepts: a `requeued: 1` stub
    // could answer the endpoint but could never move `delivered` off zero.
    let reject = true
    const receiver = httpServer((_req, res) => { res.writeHead(reject ? 500 : 204); res.end() })
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve))
    const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`
    const hub = await ModelInfra.init({ appId: "app", db: ":memory:", cache: false, syncCatalog: false, pricingAutoSync: false,
      pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {},
      webhooks: [hookConfig({ url: receiverUrl, timeoutMs: 2000, maxRetries: 0, durable: true })] })
    const server = await createServer({ hub, port: 0, host: "127.0.0.1", token: "admin-credential" })
    try {
      const auth = { authorization: "Bearer admin-credential" }
      const before = await (await fetch(`${server.url}/api/webhooks/outbox/stats`, { headers: auth })).json() as { mode: string; deadLetter: number }
      expect(before.mode).toBe("durable")
      expect(before.deadLetter).toBe(0)
      expect(hub.webhooks.test()).toBe(true)
      await waitFor(() => hub.webhooks.outboxStats().deadLetter === 1, 500)
      const after = await (await fetch(`${server.url}/api/webhooks/outbox/stats`, { headers: auth })).json() as { mode: string; pending: number; delivered: number; deadLetter: number }
      expect(after).toMatchObject({ mode: "durable", pending: 0, delivered: 0, deadLetter: 1 })
      reject = false
      const retry = await (await fetch(`${server.url}/api/webhooks/outbox/retry-dead`, { method: "POST", headers: auth })).json()
      expect(retry).toEqual({ mode: "durable", requeued: 1 })
      // The requeued row is actually re-attempted and now lands.
      await waitFor(() => hub.webhooks.outboxStats().delivered === 1, 500)
    } finally {
      await server.close()
      await hub.close()
      receiver.closeAllConnections()
      await new Promise<void>((resolve) => receiver.close(() => resolve()))
    }
  })
})
