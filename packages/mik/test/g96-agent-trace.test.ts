import { afterEach, describe, expect, it } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelInfra } from "../src/index.js"
import { createServer, type ServerHandle } from "../src/server/index.js"
import { Store } from "../src/store/database.js"

const TOKEN = "g96-local-test-token"
const offlineFetch = (async () => {
  throw new Error("network disabled in G96 tests")
}) as unknown as typeof globalThis.fetch

let hub: ModelInfra | undefined
let server: ServerHandle | undefined

afterEach(async () => {
  await server?.close()
  hub?.close()
  server = undefined
  hub = undefined
})

async function start(): Promise<string> {
  hub = await ModelInfra.init({
    appId: "g96-test-app",
    db: ":memory:",
    cacheDir: join(tmpdir(), "mik-g96-test-cache"),
    pricingFetch: offlineFetch,
    pricingAutoSync: false,
    syncCatalog: false,
  })
  server = await createServer({ hub, port: 0, token: TOKEN })
  return server.url
}

async function report(baseUrl: string, events: unknown[]): Promise<void> {
  const response = await fetch(`${baseUrl}/api/usage/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ accepted: events.length, duplicates: 0, rejected: [] })
}

describe("EVO-G96 agent trace attribution", () => {
  it("adds the trace column and trace rollup storage in schema v4", async () => {
    const store = await Store.open({ path: ":memory:" })
    try {
      expect(store.schemaVersion).toBe(4)
      const eventColumns = store.driver.prepare("PRAGMA table_info(usage_events)").all().map((row) => String(row.name))
      expect(eventColumns).toContain("trace_id")
      expect(store.driver.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_trace_rollups'").get()).toBeTruthy()
    } finally {
      store.close()
    }
  })

  it("stores traceId from reported usage and filters request details by it", async () => {
    const baseUrl = await start()
    await report(baseUrl, [
      {
        requestId: "g96-trace-a1",
        ts: 1_790_000_000_000,
        providerId: "test-provider",
        modelActual: "gpt-6-luna",
        sessionId: "session-a",
        traceId: "trace-a",
        usage: { input: 100, output: 20, reasoning: 8 },
        cost: { usd: 0.000002 },
        latencyMs: 400,
      },
      {
        requestId: "g96-trace-b1",
        ts: 1_790_000_001_000,
        providerId: "test-provider",
        modelActual: "gpt-6-sol",
        sessionId: "session-b",
        traceId: "trace-b",
        usage: { input: 80, output: 10, reasoning: 2 },
        cost: { usd: 0.000004 },
      },
    ])

    const response = await fetch(`${baseUrl}/api/usage/logs?traceId=trace-a`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    const page = (await response.json()) as { total: number; events: Array<Record<string, unknown>> }
    expect(page.total).toBe(1)
    expect(page.events[0]).toMatchObject({ requestId: "g96-trace-a1", sessionId: "session-a", traceId: "trace-a" })
  })

  it("returns session and trace aggregates with integer micro-USD totals", async () => {
    const baseUrl = await start()
    hub!.usage.record({
      requestId: "g96-trace-a1",
      ts: 1_790_000_000_000,
      source: "generate",
      providerId: "test-provider",
      modelRequested: "gpt-6-luna",
      modelActual: "gpt-6-luna",
      sessionId: "session-a",
      traceId: "trace-a",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 8 },
      cost: { usd: 0.000002, low: 0.000001, high: 0.000003, basis: "blended", source: "modelsdev" },
      latencyMs: 400,
      status: "ok",
      isStreaming: false,
    })
    hub!.usage.record({
      requestId: "g96-trace-a2",
      ts: 1_790_000_000_500,
      source: "generate",
      providerId: "test-provider",
      modelRequested: "gpt-6-luna",
      modelActual: "gpt-6-luna",
      sessionId: "session-a",
      traceId: "trace-a",
      usage: { input: 150, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 12 },
      cost: { usd: 0.000003, low: 0.000002, high: 0.000004, basis: "blended", source: "modelsdev" },
      latencyMs: 600,
      status: "ok",
      isStreaming: false,
    })

    for (const groupBy of ["trace", "session"] as const) {
      const response = await fetch(`${baseUrl}/api/usage/traces?groupBy=${groupBy}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(response.status).toBe(200)
      const payload = (await response.json()) as { groupBy: string; groups: Array<Record<string, unknown>> }
      expect(payload.groupBy).toBe(groupBy)
      expect(payload.groups).toHaveLength(1)
      expect(payload.groups[0]).toMatchObject({
        sessionId: "session-a",
        ...(groupBy === "trace" ? { traceId: "trace-a" } : {}),
        requests: 2,
        costLowUsd: 0.000003,
        costHighUsd: 0.000007,
        tokens: { reasoning: 20 },
        startedAt: 1_790_000_000_000,
        endedAt: 1_790_000_000_500,
        durationMs: 500,
      })
    }
  })

  it("keeps session and trace totals when detail rows roll into the retention tables", async () => {
    const baseUrl = await start()
    const firstTs = Date.now() - 2 * 86_400_000
    for (const [index, traceId] of ["trace-old", "trace-old"].entries()) {
      hub!.usage.record({
        requestId: `g96-rollup-${index}`,
        ts: firstTs + index * 500,
        source: "generate",
        providerId: "test-provider",
        modelRequested: "gpt-6-sol",
        modelActual: "gpt-6-sol",
        sessionId: "session-old",
        traceId,
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
        cost: { usd: 0.000001, low: 0.000001, high: 0.000002, basis: "blended", source: "modelsdev" },
        latencyMs: 200,
        status: "ok",
        isStreaming: false,
      })
    }
    expect(hub!.usage.rollupAndPrune(Date.now(), 0)).toBe(2)

    const response = await fetch(`${baseUrl}/api/usage/traces?groupBy=trace&traceId=trace-old`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { groups: Array<Record<string, unknown>> }
    expect(payload.groups).toHaveLength(1)
    expect(payload.groups[0]).toMatchObject({
      traceId: "trace-old",
      sessionId: "session-old",
      requests: 2,
      costLowUsd: 0.000002,
      costHighUsd: 0.000004,
      archivedRequests: 2,
    })
  })
})
