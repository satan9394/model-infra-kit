import { afterEach, describe, expect, it } from "vitest"
import { Store } from "../src/store/database.js"
import type { UsageEvent } from "../src/types.js"

const stores: Store[] = []

async function openStore(): Promise<Store> {
  const store = await Store.open({ path: ":memory:" })
  stores.push(store)
  return store
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close()
})

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    appId: overrides.appId ?? "g92-app",
    ts: overrides.ts ?? Date.now(),
    source: overrides.source ?? "generate",
    providerId: overrides.providerId ?? "provider-a",
    modelRequested: overrides.modelRequested ?? "provider-a:model-a",
    modelActual: overrides.modelActual ?? "model-a",
    usage: overrides.usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: overrides.cost ?? { usd: 0.000502, low: 0.000341, high: 0.000777, basis: "flat", source: "manual" },
    status: overrides.status ?? "ok",
    isStreaming: overrides.isStreaming ?? false,
    tags: overrides.tags ?? { feature: "agent" },
  }
}

describe("EVO-G92 — trend and bucket cost range aggregates", () => {
  it("sums both range endpoints as integer micro-USD and preserves them through rollup", async () => {
    const store = await openStore()
    const day = new Date()
    day.setHours(12, 0, 0, 0)
    const ts = day.getTime()

    store.usage.insert(event({ requestId: "g92-a", ts }))
    store.usage.insert(
      event({
        requestId: "g92-b",
        ts: ts + 1_000,
        cost: { usd: 0.000009, low: 0.000004, high: 0.000011, basis: "flat", source: "manual" },
      }),
    )

    const trends = store.usage.trends()
    const providers = store.usage.byProvider()
    const models = store.usage.byModel()

    expect(trends).toHaveLength(1)
    expect(trends[0]).toMatchObject({ costUsd: 0.000511, costLowUsd: 0.000345, costHighUsd: 0.000788 })
    expect(providers[0]).toMatchObject({ key: "provider-a", costLowUsd: 0.000345, costHighUsd: 0.000788 })
    expect(models[0]).toMatchObject({ key: "model-a", costLowUsd: 0.000345, costHighUsd: 0.000788 })

    // The public trend/provider/model results must be unchanged after detail
    // rows are folded into the integer-micro-USD rollup tables.
    expect(store.usage.rollup(ts + 86_400_000)).toBe(2)
    expect(store.usage.query().total).toBe(0)
    expect(store.usage.trends()[0]).toMatchObject({ costLowUsd: 0.000345, costHighUsd: 0.000788 })
    expect(store.usage.byProvider()[0]).toMatchObject({ costLowUsd: 0.000345, costHighUsd: 0.000788 })
    expect(store.usage.byModel()[0]).toMatchObject({ costLowUsd: 0.000345, costHighUsd: 0.000788 })
  })
})
