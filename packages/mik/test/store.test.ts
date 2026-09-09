import { afterEach, describe, expect, it } from "vitest"
import { Store } from "../src/store/database.js"
import { fromMicroUsd, localDateKey, startOfLocalDay, toMicroUsd } from "../src/store/money.js"
import type { UsageEvent } from "../src/types.js"

const stores: Store[] = []

async function openStore() {
  const store = await Store.open({ path: ":memory:" })
  stores.push(store)
  return store
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
})

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  const usage = overrides.usage ?? { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "test-app",
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "embedded",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    usage,
    cost: overrides.cost ?? { usd: 0.001, low: 0.001, high: 0.001, basis: "flat", source: "modelsdev" },
    latencyMs: overrides.latencyMs ?? 120,
    firstTokenMs: overrides.firstTokenMs ?? 40,
    status: overrides.status ?? "ok",
    errorCode: overrides.errorCode,
    isStreaming: overrides.isStreaming ?? false,
    sessionId: overrides.sessionId,
    tags: overrides.tags ?? {},
  }
}

describe("Store", () => {
  it("opens, migrates and reports a schema version", async () => {
    const store = await openStore()
    expect(store.schemaVersion).toBeGreaterThan(0)
  })

  it("round-trips providers", async () => {
    const store = await openStore()
    store.providers.upsert(
      {
        id: "deepseek",
        name: "DeepSeek",
        protocol: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyRef: "env:DEEPSEEK_API_KEY",
        headers: { "x-trace": "1" },
      },
      "app-a",
    )
    const record = store.providers.get("deepseek")
    expect(record?.name).toBe("DeepSeek")
    expect(record?.headers["x-trace"]).toBe("1")
    expect(record?.enabled).toBe(true)

    store.providers.setEnabled("deepseek", false)
    expect(store.providers.get("deepseek")?.enabled).toBe(false)
    expect(store.providers.remove("deepseek")).toBe(true)
    expect(store.providers.get("deepseek")).toBeNull()
  })

  it("replaces a provider's model catalogue", async () => {
    const store = await openStore()
    store.models.replaceForProvider("deepseek", [
      { providerId: "deepseek", modelId: "deepseek-chat", displayName: "DeepSeek Chat", source: "provider_api", capabilities: { text: true, image: false, toolCall: true, reasoning: false, structuredOutput: false }, contextWindow: 128000 },
      { providerId: "deepseek", modelId: "deepseek-reasoner", displayName: "DeepSeek Reasoner", source: "provider_api", capabilities: { text: true, image: false, toolCall: true, reasoning: true, structuredOutput: false } },
    ])
    expect(store.models.list("deepseek")).toHaveLength(2)
    store.models.replaceForProvider("deepseek", [
      { providerId: "deepseek", modelId: "deepseek-chat", displayName: "DeepSeek Chat", source: "provider_api", capabilities: { text: true, image: false, toolCall: true, reasoning: false, structuredOutput: false } },
    ])
    expect(store.models.list("deepseek")).toHaveLength(1)
    expect(store.models.get("deepseek", "deepseek-chat")?.ref).toBe("deepseek:deepseek-chat")
  })

  it("stores pricing overrides that outrank upstream", async () => {
    const store = await openStore()
    store.pricing.set({ modelId: "deepseek-chat", inputPerM: 0.28, outputPerM: 0.42 })
    expect(store.pricing.get("deepseek-chat")?.inputPerM).toBe(0.28)
    expect(store.pricing.list()).toHaveLength(1)
    expect(store.pricing.remove("deepseek-chat")).toBe(true)
  })

  it("inserts usage events idempotently and summarises them", async () => {
    const store = await openStore()
    const first = event({ requestId: "req-1", cost: { usd: 0.25, low: 0.25, high: 0.25, basis: "flat", source: "modelsdev" } })
    expect(store.usage.insert(first)).toBe(true)
    expect(store.usage.insert(first)).toBe(false)

    store.usage.insert(event({ requestId: "req-2", status: "error", cost: { usd: 0, low: 0, high: 0, basis: "flat", source: "missing" } }))
    const summary = store.usage.summary()
    expect(summary.requests).toBe(2)
    expect(summary.successes).toBe(1)
    expect(summary.failures).toBe(1)
    expect(summary.costUsd).toBeCloseTo(0.25, 6)
    expect(summary.tokens.input).toBe(2000)
    expect(summary.avgLatencyMs).toBeCloseTo(120, 6)
  })

  it("accumulates money as integer micro-USD rather than float dollars", async () => {
    const store = await openStore()
    for (let index = 0; index < 1000; index += 1) {
      store.usage.insert(
        event({ requestId: `tiny-${index}`, cost: { usd: 0.000001, low: 0.000001, high: 0.000001, basis: "flat", source: "modelsdev" } }),
      )
    }
    expect(store.usage.summary().costUsd).toBeCloseTo(0.001, 9)
    expect(toMicroUsd(store.usage.summary().costUsd)).toBe(1000)
  })

  it("folds old events into daily rollups without double counting", async () => {
    const store = await openStore()
    const yesterday = startOfLocalDay(Date.now()) - 3_600_000
    store.usage.insert(event({ requestId: "old-1", ts: yesterday, cost: { usd: 1.5, low: 1.5, high: 1.5, basis: "flat", source: "modelsdev" } }))
    store.usage.insert(event({ requestId: "today-1", ts: Date.now(), cost: { usd: 0.5, low: 0.5, high: 0.5, basis: "flat", source: "modelsdev" } }))

    const before = store.usage.summary()
    expect(before.requests).toBe(2)
    expect(before.costUsd).toBeCloseTo(2, 6)

    const rolled = store.usage.rollupAndPrune(Date.now(), 30)
    expect(rolled).toBe(1)
    expect(store.usage.query().events).toHaveLength(1)

    const after = store.usage.summary()
    expect(after.requests).toBe(2)
    expect(after.costUsd).toBeCloseTo(2, 6)
    expect(after.tokens.input).toBe(before.tokens.input)

    const trends = store.usage.trends()
    expect(trends).toHaveLength(2)
    expect(trends[0]!.date).toBe(localDateKey(yesterday))
    expect(fromMicroUsd(toMicroUsd(trends[0]!.costUsd))).toBeCloseTo(1.5, 6)
  })

  it("groups usage by provider and model across events and rollups", async () => {
    const store = await openStore()
    const yesterday = startOfLocalDay(Date.now()) - 3_600_000
    store.usage.insert(event({ requestId: "a", ts: yesterday, providerId: "deepseek", modelActual: "deepseek-chat", cost: { usd: 1, low: 1, high: 1, basis: "flat", source: "modelsdev" } }))
    store.usage.insert(event({ requestId: "b", ts: Date.now(), providerId: "anthropic", modelActual: "claude-sonnet", cost: { usd: 2, low: 2, high: 2, basis: "flat", source: "modelsdev" } }))
    store.usage.rollupAndPrune(Date.now(), 30)

    const byProvider = store.usage.byProvider()
    expect(byProvider.map((bucket) => bucket.key)).toEqual(["anthropic", "deepseek"])
    expect(byProvider[0]!.costUsd).toBeCloseTo(2, 6)
    expect(store.usage.byModel()).toHaveLength(2)
  })

  it("round-trips settings as JSON", async () => {
    const store = await openStore()
    store.settings.setJson("defaultModel", { ref: "deepseek:deepseek-chat" })
    expect(store.settings.getJson("defaultModel", { ref: "" }).ref).toBe("deepseek:deepseek-chat")
    expect(store.settings.get("missing")).toBeNull()
  })
})
