import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ModelInfra, estimateContextTokens, type RouterConfig, type ModelRequest } from "../src/index.js"
import { SmartRouter, readRouterConfig } from "../src/ai/smart-router.js"
import { createServer as createGateway, type ServerHandle } from "../src/server/server.js"
import { loadConfig } from "../src/cli/context.js"

const router: RouterConfig = { aliases: {
  auto: { rules: [{ condition: "context_tokens > 32000", target: "large:long-model" }, { condition: "context_tokens <= 4000", target: "small:short-model" }], default_target: "small:default-model" },
  general: { rules: [], default_target: "bare-model" },
} }
const request = (text: string, model = "auto"): ModelRequest => ({ model, messages: [{ role: "user", content: text }] })
const calls: Array<{ provider: string; model: string }> = []
const hubs: ModelInfra[] = []
const gateways: ServerHandle[] = []
let url = ""
const cacheDir = mkdtempSync(join(tmpdir(), "mik-smart-router-"))
const upstream = createServer(async (req, res) => {
  let raw = ""
  for await (const part of req) raw += part
  const body = JSON.parse(raw)
  calls.push({ provider: req.url!.split("/")[1]!, model: body.model })
  const base = { id: "g112", created: 1, model: body.model }
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.000123 }
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end([
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "routed answer" }, finish_reason: null }] },
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n")
  } else {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "routed answer" }, finish_reason: "stop" }], usage }))
  }
})
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
})
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close()
  for (const hub of hubs.splice(0)) await hub.close()
  calls.length = 0
})
afterAll(async () => { await new Promise<void>(resolve => upstream.close(() => resolve())) })
async function hub(config = router): Promise<ModelInfra> {
  const mik = await ModelInfra.init({ router: config, db: ":memory:", cacheDir, syncCatalog: false, pricingAutoSync: false, pricingFetch: async () => { throw new Error("offline") }, maxRetries: 0, onWarn: () => {},
    providers: [{ id: "small", baseUrl: `${url}/small` }, { id: "large", baseUrl: `${url}/large` }], defaultModel: "small:original",
  })
  hubs.push(mik)
  return mik
}

describe("G112 smart router", () => {
  it("estimates English, CJK, mixed and supplementary characters deterministically", () => {
    expect(estimateContextTokens("")).toBe(0)
    expect(estimateContextTokens("abcd")).toBe(1)
    expect(estimateContextTokens("中文かな한국")).toBe(6)
    expect(estimateContextTokens("中文abcd😀")).toBe(4)
  })
  it("measures a representative 1024-character mixed prompt below 0.1ms per estimate", () => {
    const text = "中文abcdef".repeat(128)
    for (let i = 0; i < 1000; i += 1) estimateContextTokens(text)
    const start = performance.now()
    let total = 0
    for (let i = 0; i < 10000; i += 1) total += estimateContextTokens(text)
    const average = (performance.now() - start) / 10000
    console.info(`G112 estimator: ${text.length} UTF-16 units, 10000 iterations, ${average.toFixed(6)} ms/estimate (linear heuristic)`)
    expect(total).toBe(4480000)
    expect(average).toBeLessThan(0.1)
  })
  it("routes short, >64k and unmatched context with ordered rules", () => {
    const compiled = new SmartRouter(router)
    expect(compiled.select(request("hello"))).toMatchObject({ target: "small:short-model", tags: { routing_rule: "context_tokens <= 4000", virtual_model: "auto" } })
    expect(compiled.select(request("中".repeat(65000)))?.target).toBe("large:long-model")
    expect(compiled.select(request("中".repeat(8000)))).toMatchObject({ target: "small:default-model", tags: { routing_rule: "default_target" } })
    expect(new SmartRouter({ aliases: { auto: { rules: [{ condition: "context_tokens >= 0", target: "small:first" }, { condition: "context_tokens > 1", target: "large:second" }], default_target: "small:default" } } }).select(request("hello"))?.target).toBe("small:first")
  })
  it("counts system, text parts and tool payloads; skips media without guessing", () => {
    const compiled = new SmartRouter(router)
    const input: ModelRequest = { model: "auto", system: "中".repeat(32001), messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", image: "https://example.com/photo.png" }] }] }
    expect(compiled.select(input)?.target).toBe("large:long-model")
    const toolInput: ModelRequest = { model: "auto", messages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "tool", input: "中".repeat(32001) }] }] }
    expect(compiled.select(toolInput)?.target).toBe("large:long-model")
  })
  it.each([[">", false], ["<", false], [">=", true], ["<=", true], ["==", true]])("applies %s at the exact estimated boundary", (operator, matches) => {
    const compiled = new SmartRouter({ aliases: { auto: { rules: [{ condition: `context_tokens ${operator} 5`, target: "small:match" }], default_target: "small:default" } } })
    expect(compiled.select(request("abcd"))?.target).toBe(matches ? "small:match" : "small:default")
  })
  it("copies config so later host mutation cannot alter compiled decisions", () => {
    const config: RouterConfig = { aliases: { auto: { rules: [], default_target: "small:original" } } }
    const compiled = new SmartRouter(config)
    config.aliases.auto!.default_target = "large:mutated"
    expect(compiled.select(request("hello"))?.target).toBe("small:original")
  })
  it("bypasses exact physical references and unrelated auto substrings before reading messages", () => {
    const compiled = new SmartRouter(router)
    for (const model of ["small:auto", "small:short-model", "automatic", "gpt-auto", "AUTO"]) {
      const input = { model, get messages(): ModelRequest["messages"] { throw new Error("must not estimate") } }
      expect(compiled.select(input)).toBeUndefined()
    }
  })
  it.each(["context_tokens > -1", "context_tokens > Infinity", "context_tokens > 9007199254740992", "context_tokens > 1 || true", "process.exit()", "context_tokens > 1e3", "context_tokens != 1"])("rejects unsafe or unsupported condition %s", condition => {
    expect(() => readRouterConfig({ aliases: { auto: { rules: [{ condition, target: "small:model" }], default_target: "small:model" } } })).toThrow("Invalid smart router")
  })
  it.each([null, [], { aliases: [] }, { aliases: { "small:auto": { rules: [], default_target: "small:model" } } }, { aliases: { auto: { rules: [], default_target: "auto" } } }, { aliases: { auto: { rules: [], default_target: "https://bad" } } }, { aliases: { auto: { rules: [], default_target: "small:model", secret: "sk-secret" } } }])("rejects malformed config without echoing values", value => {
    expect(() => readRouterConfig(value)).toThrow("Invalid smart router configuration.")
  })
  it("loads and validates CLI router config without writing secrets", () => {
    const path = join(cacheDir, "mik.config.json")
    writeFileSync(path, JSON.stringify({ router }))
    const io = { out: () => {}, err: () => {} }
    expect(loadConfig(path, io).router).toEqual(router)
    writeFileSync(path, JSON.stringify({ router: { aliases: { auto: { rules: [], default_target: "sk-secret bad" } } } }))
    expect(() => loadConfig(path, io)).toThrow("Invalid smart router")
  })
  it("routes real generate and retains alias trace tags with physical accounting", async () => {
    const mik = await hub()
    const input = { ...request("中".repeat(65000)), traceId: "smart-trace", tags: { routing_rule: "forged", virtual_model: "forged", api_key: "sk-secret-123456789" } }
    const response = await mik.generate(input)
    expect(response).toMatchObject({ provider: "large", model: { requested: "auto", actual: "long-model" } })
    expect(calls).toEqual([{ provider: "large", model: "long-model" }])
    expect(mik.usage.query().events[0]).toMatchObject({ providerId: "large", modelRequested: "auto", modelActual: "long-model", traceId: "smart-trace", tags: { routing_rule: "context_tokens > 32000", virtual_model: "auto" } })
    expect(JSON.stringify(mik.usage.query())).not.toContain("sk-secret")
    expect(Math.round(response.cost.usd * 1000000)).toBe(123)
    expect(input.tags.routing_rule).toBe("forged")
  })
  it("routes core streaming, bare default targets and explicit physical calls", async () => {
    const mik = await hub()
    const events = []
    for await (const event of mik.stream(request("hello"))) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: "finish", response: { provider: "small", model: { requested: "auto", actual: "short-model" } } })
    expect(mik.usage.query().events[0]?.tags).toMatchObject({ virtual_model: "auto", routing_rule: "context_tokens <= 4000" })
    expect((await mik.generate(request("hello", "general"))).model.actual).toBe("bare-model")
    expect((await mik.generate(request("中".repeat(8000)))).model.actual).toBe("default-model")
    expect(mik.usage.query().events.find(event => event.modelActual === "default-model")?.tags?.routing_rule).toBe("default_target")
    expect((await mik.generate(request("中".repeat(65000), "small:physical"))).model.actual).toBe("physical")
    expect(mik.usage.query().events.find(event => event.modelActual === "physical")?.tags?.virtual_model).toBeUndefined()
  })
  it("does not silently fallback from unavailable selected targets", async () => {
    const mik = await hub({ aliases: { auto: { rules: [{ condition: "context_tokens > 0", target: "missing:model" }], default_target: "small:default" } } })
    await expect(mik.generate(request("hello"))).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" })
    expect(calls).toHaveLength(0)
  })
  it.each([false, true])("routes real gateway stream=%s and preserves physical frame model", async stream => {
    const mik = await hub()
    const gateway = await createGateway({ hub: mik, port: 0, tokens: [] })
    gateways.push(gateway)
    const response = await fetch(`${gateway.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request("hello"), stream, trace_id: "gateway-smart" }) })
    expect(response.status).toBe(200)
    const raw = await response.text()
    if (stream) {
      const frames = raw.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
      expect(frames.every(frame => frame.model === "short-model")).toBe(true)
      expect(raw).toContain("data: [DONE]")
    } else expect(JSON.parse(raw)).toMatchObject({ model: "short-model", x_modelhub: { model_requested: "auto" } })
    expect(mik.usage.query().events[0]).toMatchObject({ traceId: "gateway-smart", providerId: "small", modelActual: "short-model", tags: { virtual_model: "auto", routing_rule: "context_tokens <= 4000", entrypoint: "openai-http" } })
  })
})
