import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelInfra, type ModelInfraOptions } from "../src/hub.js"
import { Store } from "../src/store/database.js"
import { nodeSqliteDriver, type SqlDriver } from "../src/store/driver.js"
import { UsageRepository } from "../src/store/usage-repository.js"
import type { BudgetConfig, CostInfo, UsageEvent } from "../src/types.js"
import { checkBudgetStatus } from "../src/usage/budget.js"
import { loadConfig } from "../src/cli/context.js"
import {
  budgetBaseMicros,
  isUsableBudget,
  toMicroUsd,
  UsageService,
  windowStart,
  type UsageServiceDeps,
} from "../src/usage/service.js"

type RecordInput = Omit<UsageEvent, "appId"> & { appId?: string }

/** A fixed instant inside a UTC day: 2026-03-10T12:00:00Z. */
const DAY = Date.UTC(2026, 2, 10, 12, 0, 0)

const stores: Store[] = []
const hubs: ModelInfra[] = []
const warnings: string[] = []

const offlineFetch: typeof globalThis.fetch = async () => {
  throw new Error("offline")
}

let cacheDir = ""

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "mik-g07-"))
  warnings.length = 0
})

afterEach(async () => {
  vi.restoreAllMocks()
  while (hubs.length > 0) await hubs.pop()?.close()
  while (stores.length > 0) stores.pop()?.close()
})

async function openStore(): Promise<Store> {
  const store = await Store.open({ path: ":memory:" })
  stores.push(store)
  return store
}

async function makeHub(options: ModelInfraOptions = {}): Promise<ModelInfra> {
  const hub = await ModelInfra.init({
    appId: "g07-app",
    db: ":memory:",
    cacheDir,
    pricingFetch: offlineFetch,
    syncCatalog: false,
    maxRetries: 0,
    onWarn: (message) => warnings.push(message),
    ...options,
  })
  hubs.push(hub)
  return hub
}

/** A fake clock: every time-dependent case drives this, never the real one. */
function clock(start: number): { now: () => number; set: (ts: number) => void } {
  let current = start
  return { now: () => current, set: (ts: number) => (current = ts) }
}

function input(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    ts: overrides.ts ?? DAY,
    source: overrides.source ?? "embedded",
    providerId: overrides.providerId ?? "deepseek",
    modelRequested: overrides.modelRequested ?? "deepseek:deepseek-chat",
    modelActual: overrides.modelActual ?? "deepseek-chat",
    usage: overrides.usage ?? { input: 1000, output: 200, cacheRead: 100, cacheWrite: 0, reasoning: 0 },
    cost: overrides.cost ?? cost(0.001),
    latencyMs: overrides.latencyMs ?? 120,
    firstTokenMs: overrides.firstTokenMs,
    status: overrides.status ?? "ok",
    errorCode: overrides.errorCode,
    isStreaming: overrides.isStreaming ?? false,
    sessionId: overrides.sessionId,
    tags: overrides.tags ?? {},
    appId: overrides.appId,
  }
}

function cost(usd: number): CostInfo {
  return { usd, low: usd, high: usd, basis: "flat", source: "modelsdev" }
}

function serviceWith(store: Store, budget: UsageServiceDeps["budget"], appId = "app-a"): UsageService {
  return new UsageService({
    store,
    appId,
    enabled: true,
    onWarn: (message) => warnings.push(message),
    budget,
  })
}

describe("soft budget — accumulation and one warning per window", () => {
  it("A1 warns exactly once when the threshold is crossed, with threshold/current/window/appId", async () => {
    const store = await openStore()
    const time = clock(DAY)
    const service = serviceWith(store, { usd: 0.001, now: time.now })

    expect(service.record(input({ cost: cost(0.0005) }))).toBe(true)
    expect(warnings).toHaveLength(0)

    // 500 + 600 = 1100 micros > 1000 micros.
    expect(service.record(input({ cost: cost(0.0006) }))).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("0.001000")
    expect(warnings[0]).toContain("0.001100")
    expect(warnings[0]).toContain('"day"')
    expect(warnings[0]).toContain("app-a")

    // More spending in the same window never warns a second time, and never
    // changes the `record()` contract.
    expect(service.record(input({ cost: cost(0.5) }))).toBe(true)
    expect(service.record(input({ cost: cost(0.5) }))).toBe(true)
    expect(warnings).toHaveLength(1)
  })

  it("counts only this instance's appId (the init base covers that appId alone)", async () => {
    const store = await openStore()
    const service = serviceWith(store, { usd: 0.001, now: () => DAY })

    service.record(input({ appId: "app-b", cost: cost(0.5) }))
    expect(warnings).toHaveLength(0)

    service.record(input({ cost: cost(0.0006) }))
    expect(warnings).toHaveLength(0)
    service.record(input({ cost: cost(0.0006) }))
    expect(warnings).toHaveLength(1)
  })

  it("A2 without a budget there is no warning and no cost query", async () => {
    const store = await openStore()
    const spy = vi.spyOn(UsageRepository.prototype, "costMicros")
    const service = new UsageService({ store, appId: "app-a", enabled: true, onWarn: (m) => warnings.push(m) })

    service.record(input({ cost: cost(50) }))
    service.record(input({ cost: cost(50) }))

    expect(warnings).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("soft budget status — integer limits and overage", () => {
  it("keeps the requested overspend as integer micro-USD while clamping remaining to zero", () => {
    const status = checkBudgetStatus(
      {
        daily: {
          spentMicros: 1_250_000,
          unpricedRequests: 0,
          archivedRequests: 0,
          historicalAllocationLimited: false,
        },
        monthly: {
          spentMicros: 0,
          unpricedRequests: 0,
          archivedRequests: 0,
          historicalAllocationLimited: false,
        },
      },
      { dailyMicros: 1_000_000 },
      DAY,
    )

    expect(status.daily).toMatchObject({
      spentMicros: 1_250_000,
      limitMicros: 1_000_000,
      remainingMicros: 0,
      overageMicros: 250_000,
      percent: 125,
      status: "exceeded",
    })
    expect(status.monthly).toBeNull()
  })

  it("reports zero overage at the exact threshold and preserves safe integer differences", () => {
    const limitMicros = Number.MAX_SAFE_INTEGER - 10
    const exact = checkBudgetStatus(
      {
        daily: { spentMicros: limitMicros, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false },
        monthly: { spentMicros: 0, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false },
      },
      { dailyMicros: limitMicros },
      DAY,
    )
    const exceeded = checkBudgetStatus(
      {
        daily: { spentMicros: Number.MAX_SAFE_INTEGER, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false },
        monthly: { spentMicros: 0, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false },
      },
      { dailyMicros: limitMicros },
      DAY,
    )

    expect(exact.daily).toMatchObject({ overageMicros: 0, remainingMicros: 0, status: "exceeded" })
    expect(exceeded.daily).toMatchObject({ overageMicros: 10, remainingMicros: 0, status: "exceeded" })
  })

  it("loads CLI daily/monthly limits and rejects malformed fields instead of falling back", () => {
    const dir = mkdtempSync(join(tmpdir(), "mik-budget-config-"))
    const io = { out: () => {}, err: () => {} }
    const good = join(dir, "good.json")
    writeFileSync(
      good,
      JSON.stringify({ budget: { dailyMicros: 5_000_000, monthlyMicros: 50_000_000, currency: "USD" } }),
      "utf8",
    )
    expect(loadConfig(good, io).budget).toEqual({ dailyMicros: 5_000_000, monthlyMicros: 50_000_000, currency: "USD" })

    for (const [index, budget] of [
      { usd: 1, currency: "EUR" },
      { usd: 1, window: "week" },
      { usd: 1, onExceed: "block" },
      { usd: 1, dailyMicros: 0 },
      { usd: 1, monthlyMicros: Number.MAX_SAFE_INTEGER + 1 },
    ].entries()) {
      const path = join(dir, `invalid-${index}.json`)
      writeFileSync(path, JSON.stringify({ budget }), "utf8")
      expect(loadConfig(path, io).budget).toBeUndefined()
    }
  })

  it("classifies the 80% warning edge and the 100% exceeded edge with integer percentages", () => {
    const snapshot = (spentMicros: number) => ({
      daily: { spentMicros, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false },
      monthly: { spentMicros: 0, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false },
    })
    const config = { dailyMicros: 100 }

    expect(checkBudgetStatus(snapshot(79), config, DAY).daily).toMatchObject({ percent: 79, status: "ok", overageMicros: 0 })
    expect(checkBudgetStatus(snapshot(80), config, DAY).daily).toMatchObject({ percent: 80, status: "warning", overageMicros: 0 })
    expect(checkBudgetStatus(snapshot(99), config, DAY).daily).toMatchObject({ percent: 99, status: "warning", overageMicros: 0 })
    expect(checkBudgetStatus(snapshot(100), config, DAY).daily).toMatchObject({ percent: 100, status: "exceeded", overageMicros: 0 })
  })

  it("uses UTC leap-day and year-boundary ranges for both periods", () => {
    const calls: Array<[number, number]> = []
    const reader = {
      budgetTotals(from: number, to: number) {
        calls.push([from, to])
        return { spentMicros: 0, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false }
      },
    }

    checkBudgetStatus(reader, { dailyMicros: 1, monthlyMicros: 1 }, Date.UTC(2028, 1, 29, 23, 59, 59, 999))
    expect(calls).toEqual([
      [Date.UTC(2028, 1, 29), Date.UTC(2028, 2, 1)],
      [Date.UTC(2028, 1, 1), Date.UTC(2028, 2, 1)],
    ])

    calls.length = 0
    checkBudgetStatus(reader, { dailyMicros: 1, monthlyMicros: 1 }, Date.UTC(2027, 11, 31, 23, 59, 59, 999))
    expect(calls).toEqual([
      [Date.UTC(2027, 11, 31), Date.UTC(2028, 0, 1)],
      [Date.UTC(2027, 11, 1), Date.UTC(2028, 0, 1)],
    ])
  })

  it("keeps a timestamp near midnight on the UTC date for a west-coast local zone", () => {
    const calls: Array<[number, number]> = []
    const reader = {
      budgetTotals(from: number, to: number) {
        calls.push([from, to])
        return { spentMicros: 0, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false }
      },
    }
    checkBudgetStatus(reader, { dailyMicros: 1 }, Date.UTC(2026, 2, 10, 0, 30))
    expect(calls[0]).toEqual([Date.UTC(2026, 2, 10), Date.UTC(2026, 2, 11)])
  })

  it("keeps a timestamp near midnight on the UTC date for an east-asia local zone", () => {
    const calls: Array<[number, number]> = []
    const reader = {
      budgetTotals(from: number, to: number) {
        calls.push([from, to])
        return { spentMicros: 0, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false }
      },
    }
    checkBudgetStatus(reader, { dailyMicros: 1 }, Date.UTC(2026, 2, 10, 23, 30))
    expect(calls[0]).toEqual([Date.UTC(2026, 2, 10), Date.UTC(2026, 2, 11)])
  })

  it("does not query usage for inactive configs and rejects invalid clocks or totals", () => {
    let reads = 0
    const reader = {
      budgetTotals() {
        reads += 1
        throw new Error("must not be called")
      },
    }

    expect(checkBudgetStatus(reader, undefined, Number.NaN)).toEqual({ currency: "USD", advisory: true, daily: null, monthly: null })
    expect(checkBudgetStatus(reader, { dailyMicros: 0 }, DAY).daily).toBeNull()
    expect(checkBudgetStatus(reader, { dailyMicros: 1, currency: "EUR" } as unknown as BudgetConfig, DAY).daily).toBeNull()
    expect(reads).toBe(0)
    expect(() => checkBudgetStatus(reader, { dailyMicros: 1 }, Number.NaN)).toThrow(RangeError)
    expect(() =>
      checkBudgetStatus(
        {
          daily: {
            spentMicros: Number.MAX_SAFE_INTEGER + 1,
            unpricedRequests: 0,
            archivedRequests: 0,
            historicalAllocationLimited: false,
          },
          monthly: { spentMicros: 0, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false },
        },
        { dailyMicros: 1 },
        DAY,
      ),
    ).toThrow(RangeError)
  })
})

describe("soft budget — window boundaries (UTC)", () => {
  it("A3 day window resets at the UTC day boundary and can warn once more", async () => {
    const store = await openStore()
    const time = clock(Date.UTC(2026, 2, 10, 23, 59, 0))
    const service = serviceWith(store, { usd: 0.001, window: "day", baseMicros: 900, now: time.now })

    service.record(input({ ts: time.now(), cost: cost(0.0002) }))
    expect(warnings).toHaveLength(1)

    service.record(input({ ts: time.now(), cost: cost(0.01) }))
    expect(warnings).toHaveLength(1)

    // 2026-03-11T00:00:30Z: a new UTC day. The init base belonged to the old one.
    time.set(Date.UTC(2026, 2, 11, 0, 0, 30))
    service.record(input({ ts: time.now(), cost: cost(0.0005) }))
    expect(warnings).toHaveLength(1)

    service.record(input({ ts: time.now(), cost: cost(0.0006) }))
    expect(warnings).toHaveLength(2)

    service.record(input({ ts: time.now(), cost: cost(0.5) }))
    expect(warnings).toHaveLength(2)
  })

  it("A3 month window survives a day boundary and resets at the UTC month boundary", async () => {
    const store = await openStore()
    const time = clock(Date.UTC(2026, 2, 31, 23, 30, 0))
    const service = serviceWith(store, { usd: 0.001, window: "month", now: time.now })

    service.record(input({ ts: time.now(), cost: cost(0.0006) }))
    expect(warnings).toHaveLength(0)

    // April begins: the March 600 micros are gone, nothing warns yet.
    time.set(Date.UTC(2026, 3, 1, 0, 5, 0))
    service.record(input({ ts: time.now(), cost: cost(0.0006) }))
    expect(warnings).toHaveLength(0)

    service.record(input({ ts: time.now(), cost: cost(0.0006) }))
    expect(warnings).toHaveLength(1)

    // A day boundary inside the same month is *not* a window boundary.
    time.set(Date.UTC(2026, 3, 2, 10, 0, 0))
    service.record(input({ ts: time.now(), cost: cost(0.0005) }))
    expect(warnings).toHaveLength(1)

    // May does start a new window.
    time.set(Date.UTC(2026, 4, 1, 0, 1, 0))
    service.record(input({ ts: time.now(), cost: cost(0.0006) }))
    expect(warnings).toHaveLength(1)
    service.record(input({ ts: time.now(), cost: cost(0.0006) }))
    expect(warnings).toHaveLength(2)
  })

  it("windowStart returns UTC day/month starts regardless of the host's local zone", () => {
    expect(windowStart("day", Date.UTC(2026, 2, 10, 23, 59, 59))).toBe(Date.UTC(2026, 2, 10))
    expect(windowStart("day", Date.UTC(2026, 2, 10, 0, 0, 1))).toBe(Date.UTC(2026, 2, 10))
    expect(windowStart("month", Date.UTC(2026, 2, 31, 23, 59, 59))).toBe(Date.UTC(2026, 2, 1))
    // A local-midnight-based implementation would land on a different value for
    // an instant that falls on another local day.
    expect(windowStart("day", Date.UTC(2026, 2, 10, 23, 59, 59))).not.toBe(Date.UTC(2026, 2, 11))
  })
})

describe("soft budget — money is integer micro-USD", () => {
  it("rounds each row to whole micros, so a window total never drifts from the SQL sum", async () => {
    const store = await openStore()
    const service = serviceWith(store, { usd: 0.000744, now: () => DAY })

    expect(toMicroUsd(0.0002475)).toBe(248)
    for (let i = 0; i < 3; i += 1) service.record(input({ cost: cost(0.0002475) }))

    // 3 × ROUND(247.5) = 744, not ROUND(742.5) = 743 as a float sum would give.
    expect(store.usage.costMicros("app-a", windowStart("day", DAY), DAY + 60_000)).toBe(744)
    expect(warnings).toHaveLength(0)

    service.record(input({ cost: cost(0.0002475) }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("0.000992")
  })

  it("sums the window base from the store in integer micros, excluding other windows and apps", async () => {
    const store = await openStore()
    const seeder = new UsageService({ store, appId: "app-a", enabled: true })

    seeder.record(input({ ts: DAY, cost: cost(0.0002475) }))
    seeder.record(input({ ts: DAY + 1_000, cost: cost(0.0002475) }))
    seeder.record(input({ ts: Date.UTC(2026, 2, 9, 23, 0, 0), cost: cost(0.5) }))
    seeder.record(input({ ts: DAY, appId: "app-b", cost: cost(0.5) }))

    const base = budgetBaseMicros({ store, appId: "app-a", window: "day", now: DAY + 60_000, onWarn: () => {} })
    expect(base).toBe(496)

    const monthBase = budgetBaseMicros({ store, appId: "app-a", window: "month", now: DAY + 60_000, onWarn: () => {} })
    expect(monthBase).toBe(496 + toMicroUsd(0.5))

    // The base hands the threshold straight over: 400 more micros crosses it.
    const service = serviceWith(store, { usd: 0.001, baseMicros: base, now: () => DAY })
    service.record(input({ cost: cost(0.0004) }))
    expect(warnings).toHaveLength(0)
    service.record(input({ cost: cost(0.000105) }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("0.001001")
  })
})

describe("soft budget status — app scope and retained history", () => {
  it("keeps apps isolated and surfaces unpriced detail plus archived rollup flags", async () => {
    const store = await openStore()
    const serviceA = serviceWith(store, undefined, "app-a")
    const serviceB = serviceWith(store, undefined, "app-b")
    const old = Date.UTC(2026, 2, 1, 12, 0, 0)
    const now = Date.UTC(2026, 2, 10, 23, 0, 0)
    const current = now - 60 * 60 * 1000

    serviceA.record(input({ requestId: "budget-old-a", appId: "app-a", ts: old, cost: cost(0.000007) }))
    serviceA.record(
      input({
        requestId: "budget-missing-a",
        appId: "app-a",
        ts: current,
        cost: { ...cost(0), source: "missing", basis: "unknown" },
      }),
    )
    serviceA.record(input({ requestId: "budget-current-a", appId: "app-a", ts: current, cost: cost(0.000003) }))
    serviceA.record(input({ requestId: "budget-current-b", appId: "app-b", ts: current, cost: cost(0.000009) }))

    expect(serviceA.rollupAndPrune(now, 30)).toBe(1)

    const day = serviceA.budgetTotals(Date.UTC(2026, 2, 10), Date.UTC(2026, 2, 11))
    expect(day).toMatchObject({ spentMicros: 3, unpricedRequests: 1, archivedRequests: 0, historicalAllocationLimited: false })

    const month = serviceA.budgetTotals(Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1))
    expect(month).toMatchObject({ spentMicros: 10, unpricedRequests: 1, archivedRequests: 1, historicalAllocationLimited: true })

    const otherApp = serviceB.budgetTotals(Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1))
    expect(otherApp).toMatchObject({ spentMicros: 9, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false })
  })
})

describe("soft budget — invalid config and failures stay silent", () => {
  it("A4 ignores a non-positive or non-finite usd with exactly one warning, and keeps metering", async () => {
    const store = await openStore()
    for (const usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      warnings.length = 0
      const service = serviceWith(store, { usd, now: () => DAY })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("invalid budget")
      expect(service.record(input({ cost: cost(9999) }))).toBe(true)
      expect(warnings).toHaveLength(1)
    }
    expect(store.usage.summary({ appId: "app-a" }).requests).toBe(4)
  })

  it("A4 ignores unsupported window/onExceed values that only a JS host could pass", async () => {
    const store = await openStore()
    // Parsed JSON mirrors the real vector for these values: a JS host, or a
    // config file, handing over what the TypeScript contract forbids. The
    // runtime must survive it.
    const badWindow = JSON.parse('{"usd":1,"window":"week"}') as BudgetConfig
    const badOnExceed = JSON.parse('{"usd":1,"onExceed":"block"}') as BudgetConfig

    expect(isUsableBudget(badWindow)).toBe(false)
    expect(isUsableBudget(badOnExceed)).toBe(false)
    expect(isUsableBudget({ usd: 1 })).toBe(true)
    expect(isUsableBudget(undefined)).toBe(false)

    const service = serviceWith(store, badWindow)
    expect(warnings).toHaveLength(1)
    expect(service.record(input({ cost: cost(9999) }))).toBe(true)
    expect(warnings).toHaveLength(1)
  })

  it("A4 degrades to a 0 base (one warning, no throw) when the window sum fails", async () => {
    const store = await openStore()
    vi.spyOn(UsageRepository.prototype, "costMicros").mockImplementation(() => {
      throw new Error("database is locked")
    })

    expect(budgetBaseMicros({ store, appId: "app-a", window: "day", now: DAY, onWarn: (m) => warnings.push(m) })).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Could not total")
  })

  it("A4 init survives a failing base sum and starts the budget from 0", async () => {
    vi.spyOn(UsageRepository.prototype, "costMicros").mockImplementation(() => {
      throw new Error("database is locked")
    })
    const hub = await makeHub({ budget: { usd: 0.001 } })

    expect(warnings.some((message) => message.includes("Could not total"))).toBe(true)
    hub.usage.record(input({ cost: cost(0.0006) }))
    expect(warnings.filter((message) => message.includes("Usage budget exceeded"))).toHaveLength(0)
    hub.usage.record(input({ cost: cost(0.0006) }))
    expect(warnings.filter((message) => message.includes("Usage budget exceeded"))).toHaveLength(1)
  })
})

describe("soft budget — hub wiring", () => {
  it("A2 performs no budget query at all when no budget is configured", async () => {
    const spy = vi.spyOn(UsageRepository.prototype, "costMicros")
    const hub = await makeHub()

    expect(spy).not.toHaveBeenCalled()
    hub.usage.record(input({ cost: cost(50) }))
    expect(spy).not.toHaveBeenCalled()
    // The offline pricing fetch warns once on its own; nothing budget-related may.
    expect(warnings.filter((message) => message.toLowerCase().includes("budget"))).toHaveLength(0)
  })

  it("sums the window base exactly once, at init, and never per record()", async () => {
    const spy = vi.spyOn(UsageRepository.prototype, "costMicros")
    const hub = await makeHub({ budget: { usd: 1 } })

    expect(spy).toHaveBeenCalledTimes(1)
    hub.usage.record(input({ cost: cost(0.5) }))
    hub.usage.record(input({ cost: cost(0.5) }))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("warns once through the hub and never blocks the call", async () => {
    const hub = await makeHub({ budget: { usd: 0.001, window: "month" } })

    hub.usage.record(input({ cost: cost(0.0006) }))
    hub.usage.record(input({ cost: cost(0.0006) }))
    hub.usage.record(input({ cost: cost(5) }))

    const exceeded = warnings.filter((message) => message.includes("Usage budget exceeded"))
    expect(exceeded).toHaveLength(1)
    expect(exceeded[0]).toContain("g07-app")
    expect(exceeded[0]).toContain('"month"')
    expect(hub.usage.summary().requests).toBe(3)
  })
})

describe("review follow-ups (G07 S2/S4)", () => {
  it("survives a throwing onWarn sink and never repeats the warning (S4)", async () => {
    const store = await openStore()
    const time = clock(DAY)
    let attempts = 0
    const service = new UsageService({
      store,
      appId: "app-a",
      enabled: true,
      onWarn: () => {
        attempts += 1
        throw new Error("host sink exploded")
      },
      budget: { usd: 0.001, now: time.now },
    })

    // The sink's throw must not escape `record()` (A4) ...
    expect(service.record(input({ cost: cost(0.0011) }))).toBe(true)
    expect(attempts).toBe(1)
    // ... and the same window must not be retried because the key is added first.
    expect(service.record(input({ cost: cost(0.5) }))).toBe(true)
    expect(attempts).toBe(1)
  })

  it("prepares no new statement while recording once a budget is configured (S2)", async () => {
    let prepares = 0
    const countingDriver = async (target: string): Promise<SqlDriver> => {
      const real = await nodeSqliteDriver(target)
      return {
        exec: (sql: string) => real.exec(sql),
        prepare: (sql: string) => {
          prepares += 1
          return real.prepare(sql)
        },
        close: () => real.close(),
      }
    }
    const store = await Store.open({ path: ":memory:", driver: countingDriver })
    stores.push(store)
    const time = clock(DAY)
    const service = serviceWith(store, { usd: 0.001, now: time.now })

    // `insert()` prepares per call, so the invariant is not "zero statements" but
    // "the budget adds none": compare the growth with and without a budget.
    service.record(input({ cost: cost(0.0001) }))
    const before = prepares
    service.record(input({ cost: cost(0.0001) }))
    service.record(input({ cost: cost(0.0001) }))
    const withBudget = prepares - before
    expect(withBudget).toBeGreaterThan(0) // the inserts themselves

    // Same counting driver, or the control group's prepares would not be counted.
    const plainStore = await Store.open({ path: ":memory:", driver: countingDriver })
    stores.push(plainStore)
    const plain = serviceWith(plainStore, undefined)
    plain.record(input({ cost: cost(0.0001) }))
    const plainBefore = prepares
    plain.record(input({ cost: cost(0.0001) }))
    plain.record(input({ cost: cost(0.0001) }))
    expect(prepares - plainBefore).toBe(withBudget)
  })
})

