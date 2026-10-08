import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelInfra } from "../src/hub.js"
import { createServer, type ServerHandle } from "../src/server/server.js"
import { checkBudgetStatus } from "../src/usage/budget.js"
import { loadConfig } from "../src/cli/context.js"
import type { BudgetConfig } from "../src/types.js"

const hubs: ModelInfra[] = []
const servers: ServerHandle[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  for (const hub of hubs.splice(0)) await hub.close()
})

async function fixture(budget: BudgetConfig, spentMicros: number, serverBudget?: BudgetConfig) {
  const warnings: string[] = []
  const hub = await ModelInfra.init({ appId: "g125", db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-g125-")), syncCatalog: false, pricingFetch: async () => { throw new Error("offline") }, budget, onWarn: () => {} })
  hubs.push(hub)
  hub.usage.record({ requestId: "spent", ts: Date.now(), source: "test", providerId: "p", modelRequested: "m", modelActual: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: spentMicros / 1_000_000, low: spentMicros / 1_000_000, high: spentMicros / 1_000_000, basis: "exact", source: "manual" }, status: "ok", isStreaming: false })
  const generate = vi.spyOn(hub, "generate").mockResolvedValue({ text: "ok", toolCalls: [], finishReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: 0, low: 0, high: 0, basis: "exact", source: "manual" }, provider: "p", model: { requested: "m", actual: "m" }, latencyMs: 0 })
  const native = vi.spyOn(hub, "fetch").mockResolvedValue(new Response('{"ok":true}', { headers: { "content-type": "application/json" } }))
  const server = await createServer({ hub, port: 0, budget: serverBudget, tokens: [{ token: "g125-chat", scopes: ["write:chat", "read:usage"] }, { token: "g125-admin", scopes: ["admin"] }], onWarn: message => warnings.push(message) })
  servers.push(server)
  const post = (endpoint = "chat/completions", headers: Record<string, string> = {}) => fetch(`${server.url}/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer g125-chat", ...headers }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })
  return { server, hub, generate, native, warnings, post }
}

describe("local hard budget cap", () => {
  it.each(["dailyMicros", "monthlyMicros"] as const)("blocks at the exact %s threshold before any upstream call", async window => {
    const f = await fixture({ hardCap: true, [window]: 10 }, 10)
    for (const endpoint of ["chat/completions", "messages", "responses"]) {
      const response = await f.post(endpoint)
      expect(response.status).toBe(429)
      expect(await response.json()).toMatchObject({ error: { code: "BUDGET_EXCEEDED" } })
    }
    expect(f.generate).not.toHaveBeenCalled()
    expect(f.native).not.toHaveBeenCalled()
    expect(f.hub.usage.summary().requests).toBe(1)
  })
  it("allows the last micro below the cap and defaults to advisory", async () => {
    const below = await fixture({ hardCap: true, dailyMicros: 10 }, 9)
    expect((await below.post()).status).toBe(200)
    expect(below.generate).toHaveBeenCalledOnce()
    const soft = await fixture({ dailyMicros: 10 }, 11)
    expect((await soft.post()).status).toBe(200)
  })
  it.each<Record<string, string>>([{ authorization: "Bearer g125-admin" }, { "x-mik-bypass-budget": "true" }])("allows explicit privileges with a redacted warning", async headers => {
    const f = await fixture({ hardCap: true, dailyMicros: 10 }, 11)
    expect((await f.post("chat/completions", headers)).status).toBe(200)
    expect(f.generate).toHaveBeenCalledOnce()
    expect(f.warnings).toEqual(["BUDGET_EXCEEDED: privileged budget bypass allowed."])
    expect(f.warnings.join()).not.toContain("g125-admin")
  })
  it("requires normal authentication even with a bypass header", async () => {
    const f = await fixture({ hardCap: true, dailyMicros: 10 }, 10)
    expect((await f.post("chat/completions", { authorization: "Bearer wrong", "x-mik-bypass-budget": "true" })).status).toBe(401)
    expect(f.generate).not.toHaveBeenCalled()
    expect((await f.post("chat/completions", { "x-mik-bypass-budget": "false" })).status).toBe(429)
  })
  it("accepts server parameters and reports the same cap to the dashboard", async () => {
    const f = await fixture({}, 10, { hardCap: true, monthlyMicros: 10 })
    expect((await f.post()).status).toBe(429)
    const response = await fetch(`${f.server.url}/api/budget/status`, { headers: { authorization: "Bearer g125-chat" } })
    expect(await response.json()).toMatchObject({ hardCap: true, advisory: false, monthly: { spentMicros: 10, status: "exceeded" } })
  })
  it("uses exact safe-integer totals and UTC rollover", () => {
    const total = { spentMicros: Number.MAX_SAFE_INTEGER - 1, unpricedRequests: 0, archivedRequests: 0, historicalAllocationLimited: false }
    const status = checkBudgetStatus({ daily: total, monthly: { ...total, spentMicros: Number.MAX_SAFE_INTEGER } }, { hardCap: true, dailyMicros: Number.MAX_SAFE_INTEGER, monthlyMicros: Number.MAX_SAFE_INTEGER }, Date.parse("2026-10-31T23:59:59Z"))
    expect(status.daily?.remainingMicros).toBe(1)
    expect(status.daily?.status).toBe("warning")
    expect(status.monthly?.status).toBe("exceeded")
    expect(status.monthly?.to).toBe(Date.parse("2026-11-01T00:00:00Z"))
  })
  it("scopes enforcement to the authenticated app and resets local UTC totals", async () => {
    const f = await fixture({ hardCap: true, dailyMicros: 10, monthlyMicros: 10 }, 10)
    const server = await createServer({ hub: f.hub, port: 0, tokens: [{ token: "g125-other", scopes: ["write:chat"], appId: "other" }] })
    servers.push(server)
    const response = await fetch(`${server.url}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer g125-other", "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })
    expect(response.status).toBe(200)
    expect(f.generate).toHaveBeenCalledOnce()
    const now = new Date()
    const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
    expect(f.hub.budgetStatus(nextMonth)).toMatchObject({ daily: { spentMicros: 0, status: "ok" }, monthly: { spentMicros: 0, status: "ok" } })
  })
  it("retains the hardCap boolean from CLI configuration", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mik-g125-config-")), "mik.config.json")
    writeFileSync(path, JSON.stringify({ budget: { hardCap: true, dailyMicros: 1 } }))
    expect(loadConfig(path, { out: () => {}, err: () => {} }).budget).toMatchObject({ hardCap: true, dailyMicros: 1 })
  })
})
