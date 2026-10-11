import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/store/database.js"
import { archiveCutoff } from "../src/usage/archive.js"
import type { UsageEvent } from "../src/types.js"

export const archiveDirectory = (): string => mkdtempSync(join(tmpdir(), "mik-g131-"))
export async function archiveStore(path = ":memory:", records = 33): Promise<Store> {
  const store = await Store.open({ path })
  store.driver.transaction(() => {
    for (let i = 0; i < records; i++) {
      const event: UsageEvent = { requestId: `r${i}`, appId: i % 2 ? "a" : "b", ts: archiveCutoff("2026-01-01"),
        source: "embedded", providerId: "p", modelRequested: "p:m", modelActual: "m",
        usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoning: 1 },
        cost: { usd: 0.000003, low: 0.000002, high: 0.000005, source: "manual", basis: "flat" },
        status: "ok", isStreaming: false, latencyMs: 50, traceId: "trace", sessionId: "session",
        tags: { feature: "chat", note: "sk-test123", password: "private-value" } }
      store.usage.insert(event)
    }
    store.driver.prepare("UPDATE usage_events SET cache_savings_micros = 2").run()
  })
  return store
}
