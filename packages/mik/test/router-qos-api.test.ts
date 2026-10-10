import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/server.js"

it("serves redacted instance-local QoS behind authentication/admin scope with no secret fields", async () => {
  const h = await ModelInfra.init({ db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-qos-api-")), syncCatalog: false, pricingAutoSync: false,
    pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {}, routing: "adaptive_qos",
    providers: [{ id: "p", apiKeyRef: "env:QOS_FAKE_SECRET" }],
    loadBalancer: { auto: [{ model: "p:sk-abcdefghijklmnopqrstuvwxyz0123456789", weight: 100 }] } })
  const server = await createServer({ hub: h, port: 0, tokens: [{ token: "qos-test-admin", scopes: ["admin"] }, { token: "qos-test-reader", scopes: ["read:usage"] }] })
  try {
    expect((await fetch(`${server.url}/api/providers/qos`)).status).toBe(401)
    expect((await fetch(`${server.url}/api/providers/qos`, { headers: { authorization: "Bearer qos-test-reader" } })).status).toBe(403)
    const res = await fetch(`${server.url}/api/providers/qos`, { headers: { authorization: "Bearer qos-test-admin" } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789")
    expect(text).not.toMatch(/apiKeyRef|api_key_ref|QOS_FAKE_SECRET|qos-test-admin/)
    expect(JSON.parse(text).channels[0]).toMatchObject({ providerId: "p", sampleCount: 0, ewmaTtftMs: null, qosScore: 100, effectiveWeight: 100 })
    expect((await fetch(`${server.url}/api/providers/qos`, { method: "POST", headers: { authorization: "Bearer qos-test-admin" } })).status).toBe(405)
    const openapi = await (await fetch(`${server.url}/openapi.json`, { headers: { authorization: "Bearer qos-test-admin" } })).json()
    expect(openapi.paths["/api/providers/qos"].get).toBeDefined()
  } finally { await server.close(); await h.close() }
})
