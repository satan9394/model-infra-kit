import { createServer as httpServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/server.js"
import type { TenantQuotas } from "../src/quota/hierarchy.js"
import { reserveTokens } from "../src/server/quota.js"
import { DatabaseSync } from "node:sqlite"

const directory = mkdtempSync(join(tmpdir(), "mik-g133-"))
let calls = 0, origin = ""
const upstream = httpServer(async (req, res) => {
  for await (const _part of req) { /* drain the real request */ }
  calls++
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ id: "g133", object: "chat.completion", created: 1, model: "model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }))
})
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>(resolve => upstream.close(() => resolve())) })

async function fixture(quotas: TenantQuotas, db = ":memory:") {
  const hub = await ModelInfra.init({ appId: "a", db, cacheDir: directory, syncCatalog: false, pricingAutoSync: false,
    env: { G133_KEY: "sk-fixture-do-not-leak" }, providers: [{ id: "p", baseUrl: origin, apiKeyRef: "env:G133_KEY" }],
    defaultModel: "p:model", pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {} })
  hub.pricing.setOverride({ modelId: "model", inputPerM: 1, outputPerM: 1 })
  const server = await createServer({ hub, port: 0, quotas, tokens: [
    { token: "a-credential-1", appId: "a", scopes: ["write:chat", "read:usage"] },
    { token: "b-credential-2", appId: "b", scopes: ["admin"] },
    { token: "c-credential-3", appId: "c", scopes: ["write:chat", "read:usage"] },
  ] })
  const post = (app = "a", endpoint = "chat/completions", extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    fetch(`${server.url}/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${app}-credential-${app === "a" ? 1 : app === "b" ? 2 : 3}`, ...headers },
    body: JSON.stringify({ model: "p:model", messages: [{ role: "user", content: "hello" }], max_tokens: 10, ...extra }) })
  const get = (app = "a") => fetch(`${server.url}/api/quotas`, { headers: {authorization: `Bearer ${app}-credential-${app === "a" ? 1 : app === "b" ? 2 : 3}`} })
  return { hub, server, post, get, close: async () => { await server.close(); await hub.close() } }
}

describe("authenticated hierarchical HTTP quota guard", () => {
  it("rejects reload that would disable durable quota metering", async () => {
    const db = join(directory,"quota-reload.db")
    const f = await fixture({applications:[{appId:"a",maxRpm:1}]},db)
    try {
      await expect(createServer({hub:f.hub,port:0,quotas:{applications:[{appId:"a"}]},reload:{configPath:join(directory,"config.json"),hubOptions:{appId:"a",db,cacheDir:directory,recordUsage:false}}})).rejects.toThrow("enabled usage ledger")
    } finally {await f.close()}
  })
  it("reads authoritative integer columns beyond Number precision without USD conversion", async () => {
    const db = join(directory, "quota-bigint.db")
    const f = await fixture({applications:[{appId:"a",monthlyHardCapMicros:9007199254740993n}]}, db)
    try {
      expect((await f.post()).status).toBe(200)
      const raw = new DatabaseSync(db)
      try { raw.prepare("UPDATE usage_events SET cost_micros = ? WHERE status = 'ok'").run(9007199254740993n) } finally { raw.close() }
      expect(f.hub.usage.quotaCostMicros(0, Date.now() + 1)).toBe(9007199254740993n)
      expect((await f.post()).status).toBe(429)
      const data = await (await f.get()).json()
      expect(data.quotas[0].monthlySpentMicros).toBe("9007199254740993")
    } finally { await f.close() }
  })
  it("shares the parent across siblings, blocks all three routes and records zero-cost audits", async () => {
    const f = await fixture({ organizations: [{ orgId: "org", maxRpm: 1 }], applications: [{ appId: "a", orgId: "org" }, { appId: "b", orgId: "org" }] })
    try {
      const start = calls
      expect((await f.post()).status).toBe(200)
      for (const endpoint of ["chat/completions", "messages", "responses"]) {
        const response = await f.post("b", endpoint, {}, { "x-mik-bypass-budget": "true" })
        expect(response.status).toBe(429)
        expect(response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/)
        expect(Number(response.headers.get("x-mik-ratelimit-reset"))).toBeGreaterThan(Math.floor(Date.now() / 1000))
        expect(response.headers.get("x-mik-ratelimit-remaining-requests")).toBe("0")
        expect(await response.json()).toMatchObject({ error: { code: "RPM_EXCEEDED" } })
      }
      expect(calls - start).toBe(1)
      const blocked = f.hub.usage.query({ appId: "b", status: "RATE_LIMITED" }).events
      expect(blocked).toHaveLength(3)
      expect(blocked.every(event => event.costMicros === 0 && event.cost.usd === 0)).toBe(true)
      expect(JSON.stringify(blocked)).not.toContain("credential")
      const response = await fetch(`${f.server.url}/api/usage/logs?status=RATE_LIMITED`, {headers:{authorization:"Bearer b-credential-2"}})
      expect(response.status).toBe(200)
    } finally { await f.close() }
  })
  it("blocks parent spend from another app and persists it across restart", async () => {
    const db = join(directory, "quota-persistence.db")
    const config = { organizations: [{ orgId: "o", monthlyHardCapMicros: 3n }], applications: [{ appId: "a", orgId: "o" }, { appId: "b", orgId: "o" }] }
    const first = await fixture(config, db)
    try { expect((await first.post()).status).toBe(200) } finally { await first.close() }
    const second = await fixture(config, db)
    try {
      const start = calls
      const response = await second.post("b")
      expect(response.status).toBe(429)
      expect(await response.json()).toMatchObject({error:{code:"ORG_BUDGET_EXCEEDED"}})
      expect(calls).toBe(start)
      expect(second.hub.usage.withAppScope("a", () => second.hub.usage.quotaCostMicros(0, Date.now() + 1))).toBe(3n)
      expect(second.hub.usage.withAppScope("b", () => second.hub.usage.quotaCostMicros(0, Date.now() + 1))).toBe(0n)
    } finally { await second.close() }
  })
  it("enforces TPM reservations before concurrent output and rejects unbounded requests", async () => {
    const body = {model:"p:model",messages:[{role:"user",content:"hello"}],max_tokens:10}
    const tokens = reserveTokens(body)
    const f = await fixture({ applications: [{ appId: "a", maxTpm: tokens }] })
    try {
      expect((await f.post("a", "chat/completions", { max_tokens: undefined })).status).toBe(400)
      expect((await f.post("a", "chat/completions", { max_tokens: undefined, max_output_tokens: 10 })).status).toBe(400)
      expect((await f.post("a", "responses", { max_tokens: 10 })).status).toBe(400)
      expect((await f.post("a", "messages", { max_tokens: undefined, max_completion_tokens: 10 })).status).toBe(400)
      expect((await f.post("a", "chat/completions", { n: 2 })).status).toBe(400)
      expect((await f.post("a", "messages", {messages:[{role:"user",content:[{type:"document",source:{type:"url",url:"https://example.com/a.pdf"}}]}]})).status).toBe(400)
      for(const extra of [{previous_response_id:"resp_123"},{conversation:"conv_123"},{prompt:{id:"pmpt_123"}},
        {input:[{type:"item_reference",id:"item_123"}]},{tools:[{type:"web_search"}]}]) {
        expect((await f.post("a", "responses", {max_output_tokens:10,...extra})).status).toBe(400)
      }
      expect((await f.post()).status).toBe(200)
      expect((await f.post()).status).toBe(429)
      expect((await f.post("a", "chat/completions", {messages:[{role:"user",content:[{type:"image_url",image_url:{url:"https://example.com/a.png"}}]}]})).status).toBe(400)
      expect((await f.get()).status).toBe(200)
    } finally { await f.close() }
  })
  it("fails closed on unknown apps and forged headers without consuming another tenant", async () => {
    const f = await fixture({ applications: [{ appId: "a", maxRpm: 1 }, { appId: "b", maxRpm: 1 }] })
    try {
      expect((await f.post("c")).status).toBe(403)
      expect((await f.post("a", "chat/completions", {}, {"x-mik-app-id":"b"})).status).toBe(403)
      expect((await f.post()).status).toBe(200)
      expect((await f.post("b")).status).toBe(200)
      const a = await (await f.get()).json()
      expect(a.quotas.map((entry: {appId:string}) => entry.appId)).toEqual(["a"])
      expect(a.logs).toEqual([])
      const text = await (await f.post("a", "chat/completions", {}, {authorization:"Bearer sk-malicious-123"})).text()
      expect(text).not.toContain("sk-malicious")
    } finally { await f.close() }
  })
})
