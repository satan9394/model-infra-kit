import { afterEach, describe, expect, it } from "vitest"
import { Store } from "../src/store/database.js"
import { UsageService } from "../src/usage/service.js"
import type { UsageEvent } from "../src/types.js"

type RecordInput = Omit<UsageEvent, "appId"> & { appId?: string }

const stores: Store[] = []

async function openStore(): Promise<Store> {
  const store = await Store.open({ path: ":memory:" })
  stores.push(store)
  return store
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
})

function input(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "embedded",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    usage: overrides.usage ?? { input: 1000, output: 200, cacheRead: 100, cacheWrite: 0, reasoning: 0 },
    cost: overrides.cost ?? { usd: 0.001, low: 0.001, high: 0.001, basis: "flat", source: "modelsdev" },
    latencyMs: overrides.latencyMs ?? 120,
    firstTokenMs: overrides.firstTokenMs ?? 40,
    status: overrides.status ?? "ok",
    errorCode: overrides.errorCode,
    isStreaming: overrides.isStreaming ?? false,
    sessionId: overrides.sessionId,
    tags: overrides.tags ?? {},
    appId: overrides.appId,
    pricingBasis: overrides.pricingBasis,
    pricingSource: overrides.pricingSource,
  }
}

function cost(usd: number) {
  return { usd, low: usd, high: usd, basis: "flat" as const, source: "modelsdev" as const }
}

describe("UsageService.record", () => {
  it("fills in the instance appId when the caller omits it", async () => {
    const store = await openStore()
    const service = new UsageService({ store, appId: "app-a", enabled: true })
    const event = input()

    expect(service.record(event)).toBe(true)
    expect(service.get(event.requestId)?.appId).toBe("app-a")
    expect(service.query().total).toBe(1)
  })

  it("keeps an explicitly supplied appId", async () => {
    const store = await openStore()
    const service = new UsageService({ store, appId: "app-a", enabled: true })
    const event = input({ appId: "app-explicit" })

    expect(service.record(event)).toBe(true)
    expect(service.get(event.requestId)?.appId).toBe("app-explicit")
  })

  it("is idempotent per request_id and never overwrites the stored row", async () => {
    const store = await openStore()
    const service = new UsageService({ store, appId: "app-a", enabled: true })
    const requestId = crypto.randomUUID()

    expect(service.record(input({ requestId, modelActual: "deepseek-chat", cost: cost(0.001) }))).toBe(true)
    expect(service.record(input({ requestId, modelActual: "deepseek-reasoner", cost: cost(9.999) }))).toBe(false)

    const stored = service.get(requestId)
    expect(stored?.modelActual).toBe("deepseek-chat")
    expect(stored?.cost.usd).toBeCloseTo(0.001, 9)
    expect(service.summary().requests).toBe(1)
  })

  it("returns false and persists nothing when disabled", async () => {
    const store = await openStore()
    const seen: UsageEvent[] = []
    const service = new UsageService({ store, appId: "app-a", enabled: false, onEvent: (e) => seen.push(e) })

    expect(service.record(input())).toBe(false)
    expect(seen).toHaveLength(0)
    expect(service.query({ appId: "" }).total).toBe(0)
  })

  it("notifies onEvent exactly once per stored event, with appId filled in", async () => {
    const store = await openStore()
    const seen: UsageEvent[] = []
    const service = new UsageService({ store, appId: "app-a", enabled: true, onEvent: (e) => seen.push(e) })
    const first = input()
    const second = input()

    service.record(first)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.appId).toBe("app-a")
    expect(seen[0]?.requestId).toBe(first.requestId)

    service.record(first)
    expect(seen).toHaveLength(1)

    service.record(second)
    expect(seen).toHaveLength(2)
    expect(seen[1]?.requestId).toBe(second.requestId)
  })
})

describe("UsageService queries", () => {
  it("scopes every read to this app by default and honours an explicit appId", async () => {
    const store = await openStore()
    const a = new UsageService({ store, appId: "app-a", enabled: true })
    const b = new UsageService({ store, appId: "app-b", enabled: true })

    a.record(input({ providerId: "deepseek", modelActual: "deepseek-chat", cost: cost(0.01) }))
    a.record(input({ providerId: "openai", modelActual: "gpt-4o", cost: cost(0.02), status: "error" }))
    b.record(input({ providerId: "anthropic", modelActual: "claude-sonnet-4", cost: cost(0.5) }))

    expect(a.summary().requests).toBe(2)
    expect(a.summary().successes).toBe(1)
    expect(a.summary().costUsd).toBeCloseTo(0.03, 9)
    expect(b.summary().requests).toBe(1)
    expect(b.summary().costUsd).toBeCloseTo(0.5, 9)

    expect(a.query().total).toBe(2)
    expect(b.query().total).toBe(1)

    // explicit appId wins over the instance default
    expect(a.query({ appId: "app-b" }).total).toBe(1)
    expect(a.summary({ appId: "app-b" }).costUsd).toBeCloseTo(0.5, 9)

    // appId: "" opts out of scoping entirely
    expect(a.query({ appId: "" }).total).toBe(3)

    expect(a.byProvider().map((bucket) => bucket.key).sort()).toEqual(["deepseek", "openai"])
    expect(b.byProvider().map((bucket) => bucket.key)).toEqual(["anthropic"])
    expect(a.byModel().map((bucket) => bucket.key).sort()).toEqual(["deepseek-chat", "gpt-4o"])

    const trends = a.trends()
    expect(trends).toHaveLength(1)
    expect(trends[0]?.requests).toBe(2)
    expect(b.trends(undefined, "hour")[0]?.requests).toBe(1)
  })

  it("passes filters through to the store alongside the appId", async () => {
    const store = await openStore()
    const service = new UsageService({ store, appId: "app-a", enabled: true })

    service.record(input({ providerId: "deepseek", status: "ok", sessionId: "s-1" }))
    service.record(input({ providerId: "deepseek", status: "error", sessionId: "s-1" }))
    service.record(input({ providerId: "openai", status: "ok", sessionId: "s-2" }))

    expect(service.query({ providerId: "deepseek" }).total).toBe(2)
    expect(service.query({ status: "error" }).total).toBe(1)
    expect(service.query({ sessionId: "s-2" }).total).toBe(1)
    expect(service.summary({ providerId: "deepseek" }).failures).toBe(1)
    expect(service.query({ limit: 2 }).events).toHaveLength(2)
  })

  it("get is a pass-through by request id", async () => {
    const store = await openStore()
    const a = new UsageService({ store, appId: "app-a", enabled: true })
    const b = new UsageService({ store, appId: "app-b", enabled: true })
    const event = input()
    b.record(event)

    expect(a.get(event.requestId)?.appId).toBe("app-b")
    expect(a.get("does-not-exist")).toBeNull()
  })
})

describe("UsageService maintenance", () => {
  it("rollupAndPrune folds old events and returns the deleted count", async () => {
    const store = await openStore()
    const service = new UsageService({ store, appId: "app-a", enabled: true })
    const yesterday = Date.now() - 86_400_000

    service.record(input({ ts: yesterday, cost: cost(0.01) }))
    service.record(input({ ts: Date.now(), cost: cost(0.02) }))

    expect(service.rollupAndPrune()).toBe(1)
    // detail rows keep only today; the summary still sees both via the rollup
    expect(service.query().total).toBe(1)
    expect(service.summary().requests).toBe(2)
    expect(service.summary().costUsd).toBeCloseTo(0.03, 9)

    expect(service.rollupAndPrune(Date.now(), 30)).toBe(0)
  })

  it("clear only deletes this app's rows", async () => {
    const store = await openStore()
    const a = new UsageService({ store, appId: "app-a", enabled: true })
    const b = new UsageService({ store, appId: "app-b", enabled: true })

    a.record(input())
    a.record(input())
    b.record(input())

    expect(a.clear()).toBe(2)
    expect(a.query().total).toBe(0)
    expect(b.query().total).toBe(1)
    expect(a.query({ appId: "" }).total).toBe(1)
  })
})
