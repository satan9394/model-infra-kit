import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { ModelInfra } from "../src/hub.js"
import { createServer } from "../src/server/server.js"
import { deriveModelPricingTier } from "../src/pricing/tiers.js"
import { exportPriceSnapshot, priceKey } from "../src/pricing/snapshot.js"

it("meters header/body batch facts across SDK, native and streamed requests without forwarding control fields", async () => {
  vi.stubEnv("G125_FIXTURE_KEY", "sk-g125-fixture")
  const received: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = []
  const upstream = createHttpServer(async (req, res) => {
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    received.push({ headers: req.headers, body })
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000, prompt_tokens_details: { cached_tokens: 200_000 } }
    const common = { id: "g125", created: 1, model: "gpt-6-sol" }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`)
    } else {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage }))
    }
  })
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  const hub = await ModelInfra.init({ appId: "g125", db: ":memory:", cacheDir: mkdtempSync(join(tmpdir(), "mik-g125-batch-")), syncCatalog: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {}, providers: [{ id: "p", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, apiKeyRef: "env:G125_FIXTURE_KEY" }] })
  const tier = deriveModelPricingTier({ modelId: "gpt-6-sol", providerId: "p", source: "manual", updatedAt: new Date().toISOString(), inputPerM: 1, outputPerM: 2, timeOfDayDiscounts: [{ startHourUtc: 0, endHourUtc: 24, inputMultiplier: 0.5, outputMultiplier: 0.25 }] })
  expect(hub.pricing.importSnapshot(exportPriceSnapshot({ [priceKey(tier)]: tier })).errors).toEqual([])
  const gateway = await createServer({ hub, port: 0, tokens: [] })
  try {
    for (const mode of ["header", "body", "native", "stream", "regular"] as const) {
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", ...(mode === "header" ? { "x-mik-batch": "true" } : {}), ...(["native", "stream"].includes(mode) ? { "x-mik-auto-protocol": "openai" } : {}) },
        body: JSON.stringify({ model: "p:gpt-6-sol", messages: [{ role: "user", content: "hi" }], ...(mode !== "header" && mode !== "regular" ? { "X-Mik-Batch": true } : {}), ...(mode === "stream" ? { stream: true } : {}) }),
      })
      expect(response.status).toBe(200)
      await response.text()
    }
    const events = hub.usage.query({ limit: 10 }).events
    expect(events).toHaveLength(5)
    expect(events.map(event => event.cost.usd).sort()).toEqual([0.455, 0.455, 0.455, 0.455, 0.91])
    expect(events.map(event => event.tags?._mik_cache_savings_micros).sort()).toEqual(["45000", "45000", "45000", "45000", "90000"])
    expect(received).toHaveLength(5)
    for (const request of received) {
      expect(request.headers["x-mik-batch"]).toBeUndefined()
      expect(request.headers["x-mik-bypass-budget"]).toBeUndefined()
      expect(request.body.batch).toBeUndefined()
      expect(request.body["X-Mik-Batch"]).toBeUndefined()
    }
  } finally {
    await gateway.close()
    await hub.close()
    await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() })
    vi.unstubAllEnvs()
  }
})
