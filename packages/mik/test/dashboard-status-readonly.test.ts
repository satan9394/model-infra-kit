import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { ModelInfraError } from "../src/errors.js"
import { createServer } from "../src/server/server.js"

it("dashboard reads preserve breaker state, counters and sole probe across cooldown and active probing", async () => {
  let now = 0
  const hub = await ModelInfra.init({ appId: "host", db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-g140-")),
    syncCatalog: false, pricingAutoSync: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {},
    failover: { failureThreshold: 1, cooldownMs: 100, now: () => now }, routing: "adaptive_qos",
    providers: [{ id: "p" }], loadBalancer: { auto: [{ model: "p:m", weight: 100 }] } })
  const server = await createServer({ hub, port: 0, tokens: [{ token: "g140-admin", scopes: ["admin"], appId: "tenant" }] })
  const headers = { authorization: "Bearer g140-admin" }
  try {
    const breaker = hub.providerHealth
    breaker.failure("p", new ModelInfraError("failed", { status: 503, retryable: true }))
    now = 100
    const snapshot = () => JSON.stringify([...Reflect.get(breaker, "health")])
    const before = snapshot()
    for (let i = 0; i < 3; i++) {
      for (const path of ["health", "connections", "providers/qos"]) {
        const response = await fetch(`${server.url}/api/${path}`, { headers })
        expect(response.status).toBe(200)
        if (path === "connections") expect(await response.json()).toMatchObject({ appId: "tenant", authenticated: true })
        else if (path === "providers/qos") expect((await response.json()).circuits).toEqual([{ key: "p", state: "OPEN" }])
        else await response.text()
      }
    }
    expect(snapshot()).toBe(before)
    expect(breaker.state("p")).toBe("OPEN")
    expect(breaker.acquire("p")).toBe(true)
    const probing = snapshot()
    for (const path of ["health", "connections", "providers/qos"]) {
      const response = await fetch(`${server.url}/api/${path}`, { headers })
      if (path === "providers/qos") expect((await response.json()).circuits).toEqual([{ key: "p", state: "HALF_OPEN" }])
      else await response.text()
    }
    expect(snapshot()).toBe(probing)
    expect(breaker.state("p")).toBe("HALF_OPEN")
    expect(breaker.acquire("p")).toBe(false)
    const copy = breaker.snapshot()
    copy[0]!.state = "CLOSED"
    expect(breaker.state("p")).toBe("HALF_OPEN")
    breaker.success("p")
    expect((await (await fetch(`${server.url}/api/providers/qos`, { headers })).json()).circuits).toEqual([])
    expect((await fetch(`${server.url}/api/connections?appId=host`, { headers })).status).toBe(403)
  } finally { await server.close(); await hub.close() }
})

it("unauthenticated local diagnostics keep the host scope separate from authentication", async () => {
  const hub = await ModelInfra.init({ appId: "custom-host", db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-g140-local-")),
    syncCatalog: false, pricingAutoSync: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {} })
  const server = await createServer({ hub, port: 0, tokens: [] })
  try { expect(await (await fetch(`${server.url}/api/connections`)).json()).toMatchObject({ appId: "custom-host", authenticated: false }) }
  finally { await server.close(); await hub.close() }
})

it("diagnostic authentication follows each request generation after token addition and removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mik-g140-reload-"))
  const configPath = join(dir, "mik.config.json")
  const hubOptions = { appId: "custom-host", db: join(dir, "usage.db"), cacheDir: dir,
    syncCatalog: false, pricingAutoSync: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {} }
  writeFileSync(configPath, "{}")
  const hub = await ModelInfra.init(hubOptions)
  const server = await createServer({ hub, port: 0, tokens: [], reload: { configPath, hubOptions, env: { G140_ADMIN: "g140-reload-token" } } })
  const headers = { authorization: "Bearer g140-reload-token" }
  try {
    expect(await (await fetch(`${server.url}/api/connections`)).json()).toMatchObject({ appId: "custom-host", authenticated: false })
    writeFileSync(configPath, JSON.stringify({ serverTokens: [{ tokenRef: "env:G140_ADMIN", scopes: ["admin"], appId: "tenant" }] }))
    expect((await fetch(`${server.url}/api/reload`, { method: "POST" })).status).toBe(200)
    expect((await fetch(`${server.url}/api/connections`)).status).toBe(401)
    expect(await (await fetch(`${server.url}/api/connections`, { headers })).json()).toMatchObject({ appId: "tenant", authenticated: true })
    writeFileSync(configPath, "{}")
    expect((await fetch(`${server.url}/api/reload`, { method: "POST", headers })).status).toBe(200)
    expect(await (await fetch(`${server.url}/api/connections`)).json()).toMatchObject({ appId: "custom-host", authenticated: false })
  } finally { await server.close(); await hub.close() }
})
