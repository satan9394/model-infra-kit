import { createServer as httpServer, type Server } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import OpenAI from "../../../examples/openai-sdk/node_modules/openai/index.mjs"
import { ModelInfra } from "../src/hub.js"
import { createServer, type ServerHandle } from "../src/server/server.js"

const nativeFetch = globalThis.fetch
const envKeys = ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "DEEPSEEK_BASE_URL", "OPENAI_API_KEY", "MIK_GATEWAY_URL", "MIK_GATEWAY_TOKEN", "MIK_AUTO_TEST_KEY"]
const initialEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const cacheDir = mkdtempSync(join(tmpdir(), "mik-auto-cache-"))
let auto: typeof import("../src/auto.js") | undefined
let hub: ModelInfra | undefined
let gateway: ServerHandle | undefined
const servers: Server[] = []
const calls: Array<{ path: string; headers: Record<string, unknown>; payload: Record<string, unknown> }> = []

afterEach(async () => {
  auto?.restore()
  globalThis.fetch = nativeFetch
  await gateway?.close(); gateway = undefined
  await hub?.close(); hub = undefined
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  for (const key of envKeys) { if (initialEnv[key] === undefined) delete process.env[key]; else process.env[key] = initialEnv[key] }
  calls.length = 0
})

async function upstream(stream = false, secret = false, failure = false): Promise<string> {
  const server = httpServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += String(chunk)
    const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    calls.push({ path: req.url!, headers: req.headers, payload })
    const anthropic = req.url?.includes("messages")
    const content = secret ? "hello sk-auto-leaked-999" : stream ? "hello 你好" : "hello"
    if (failure) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: content, api_key: "arbitrary-secret" } })); return }
    const answer = req.url?.includes("responses") ? { id: "resp-test", object: "response", created_at: 1, model: "unit-chat", status: "completed", output: [{ type: "message", id: "message-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }
      : anthropic ? { id: "msg-test", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: content }], usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }
      : { id: "chat-test", object: "chat.completion", created: 1, model: "unit-chat", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      const frames = req.url?.includes("responses") ? [
        { type: "response.created", response: { ...answer, status: "in_progress", output: [], usage: null }, sequence_number: 0 },
        { type: "response.output_text.delta", delta: "hello", item_id: "message-1", output_index: 0, content_index: 0, sequence_number: 1 },
        { type: "response.completed", response: answer, sequence_number: 2 },
      ] : anthropic ? [
        { type: "message_start", message: { ...answer, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ] : [{ ...answer, choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { ...answer, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]
      const text = frames.map(frame => `event: ${frame.type ?? "message"}\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`).join("") + (!anthropic && !req.url?.includes("responses") ? "data: [DONE]\r\n\r\n" : "")
      // A transport chunk boundary inside JSON must not affect parsing/redaction.
      const bytes = Buffer.from(text)
      const split = secret ? bytes.indexOf("leaked") + 3 : bytes.indexOf("你好") >= 0 ? bytes.indexOf("你好") + 1 : 27
      res.write(bytes.subarray(0, split)); res.end(bytes.subarray(split))
    } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer)) }
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}/v1`
}

async function start(stream = false, defaultAnthropic = false, secret = false, failure = false): Promise<void> {
  const base = await upstream(stream, secret, failure)
  process.env.MIK_AUTO_TEST_KEY = "sk-auto-configured-123"
  process.env.OPENAI_API_KEY = "sk-auto-caller-456"
  process.env.MIK_GATEWAY_TOKEN = "local-auto-token-789"
  hub = await ModelInfra.init({ appId: "auto-test", db: ":memory:", cacheDir, syncCatalog: false,
    pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {},
    providers: [
      { id: "vendor-a", protocol: "openai-compatible", baseUrl: base, apiKeyRef: "env:MIK_AUTO_TEST_KEY", enabled: true },
      { id: "vendor-b", protocol: "anthropic", baseUrl: base, apiKeyRef: "env:MIK_AUTO_TEST_KEY", enabled: true },
    ], defaultModel: defaultAnthropic ? "vendor-b:claude-test" : "vendor-a:unit-chat",
  })
  hub.pricing.setOverride({ modelId: "unit-chat", inputPerM: 1, outputPerM: 2 })
  hub.pricing.setOverride({ modelId: "claude-test", inputPerM: 1, outputPerM: 2, cacheReadPerM: 1, cacheWritePerM: 1 })
  gateway = await createServer({ hub, port: 0, token: process.env.MIK_GATEWAY_TOKEN, tokens: [] })
  process.env.MIK_GATEWAY_URL = gateway.url
}

const body = (model: string, stream = false): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-caller-123" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 10, stream }) })

describe("one-line auto SDK adapter", () => {
  it("side-effect import captures a default official OpenAI SDK instance and records integer micros", async () => {
    await start()
    auto = await import("../src/auto.js")
    expect(process.env.OPENAI_BASE_URL).toBe(`${gateway!.url}/__mik_auto/openai/v1`)
    const answer = await new OpenAI().chat.completions.create({ model: "unit-chat", messages: [{ role: "user", content: "hi" }], seed: 42 })
    expect(answer.choices[0]!.message.content).toBe("hello")
    expect(calls[0]!.payload).toMatchObject({ model: "unit-chat", seed: 42 })
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-auto-configured-123")
    expect(calls[0]!.headers["x-mik-auto-protocol"]).toBeUndefined()
    const event = hub!.usage.query().events[0]!
    expect(event.usage).toMatchObject({ input: 10, output: 4 })
    expect(Math.round(event.cost.usd * 1_000_000)).toBe(18)
    expect(hub!.usage.query().total).toBe(1)
  })

  it("native Anthropic JSON uses a compatible provider despite an OpenAI default and accounts caches", async () => {
    await start(); auto ??= await import("../src/auto.js"); expect(await auto.install()).toBe(true)
    const response = await fetch("https://api.anthropic.com/v1/messages", body("claude-test"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ type: "message", content: [{ text: "hello" }] })
    expect(calls[0]!.path).toBe("/v1/messages")
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-auto-configured-123")
    expect(calls[0]!.payload.model).toBe("claude-test")
    const event = hub!.usage.query().events[0]!
    expect(event.providerId).toBe("vendor-b")
    expect(event.usage).toEqual({ input: 15, output: 4, cacheRead: 3, cacheWrite: 2, reasoning: 0 })
    expect(Math.round(event.cost.usd * 1_000_000)).toBe(23)
  })

  it("the official default OpenAI Responses API forwards native input/options and meters input/output usage", async () => {
    await start(); expect(await auto!.install()).toBe(true)
    const response = await new OpenAI().responses.create({ model: "unit-chat", input: "hi", store: false })
    expect(response.output_text).toBe("hello")
    expect(calls[0]!.path).toBe("/v1/responses")
    expect(calls[0]!.payload).toMatchObject({ model: "unit-chat", input: "hi", store: false })
    const event = hub!.usage.query().events[0]!
    expect(event.usage).toMatchObject({ input: 10, output: 4 })
    expect(Math.round(event.cost.usd * 1_000_000)).toBe(18)
  })

  it("official OpenAI Responses SSE remains transparent and meters nested response.completed usage", async () => {
    await start(true); expect(await auto!.install()).toBe(true)
    const stream = await new OpenAI().responses.create({ model: "unit-chat", input: "hi", stream: true })
    const types: string[] = []
    for await (const event of stream) types.push(event.type)
    expect(types).toEqual(["response.created", "response.output_text.delta", "response.completed"])
    const event = hub!.usage.query().events[0]!
    expect(event.isStreaming).toBe(true)
    expect(event.usage).toMatchObject({ input: 10, output: 4 })
    expect(Math.round(event.cost.usd * 1_000_000)).toBe(18)
  })

  it("official OpenAI chat SSE handles split UTF-8, CRLF and the non-JSON DONE terminator", async () => {
    await start(true); expect(await auto!.install()).toBe(true)
    const stream = await new OpenAI().chat.completions.create({ model: "unit-chat", messages: [{ role: "user", content: "hi" }], stream: true })
    let text = ""
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? ""
    expect(text).toBe("hello 你好")
    expect(hub!.usage.query().events[0]!.usage).toMatchObject({ input: 10, output: 4 })
  })

  it("preserves native Anthropic SSE and merges message_start caches with final message_delta output", async () => {
    await start(true); expect(await auto!.install()).toBe(true)
    const text = await (await fetch("https://api.anthropic.com/v1/messages", body("vendor-b:claude-test", true))).text()
    expect(text).toContain("event: message_start"); expect(text).toContain('"type":"message_stop"')
    const event = hub!.usage.query().events[0]!
    expect(event.isStreaming).toBe(true)
    expect(event.usage).toEqual({ input: 15, output: 4, cacheRead: 3, cacheWrite: 2, reasoning: 0 })
    expect(calls[0]!.payload.model).toBe("claude-test")
  })

  it("OpenAI protocol routes away from an Anthropic default; DeepSeek whitelist also forwards natively", async () => {
    await start(false, true); expect(await auto!.install()).toBe(true)
    for (const host of ["api.openai.com", "api.deepseek.com"]) {
      expect((await fetch(`https://${host}/v1/chat/completions`, body("unit-chat"))).status).toBe(200)
    }
    expect(hub!.usage.query().total).toBe(2)
    expect(hub!.usage.query().events.every(event => event.providerId === "vendor-a")).toBe(true)
  })

  it("non-target calls retain exact original input/init and reject host suffix/credentials/port/protocol confusion", async () => {
    await start()
    const original = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("/api/health")) return nativeFetch(input, init)
      return new Response("direct")
    })
    globalThis.fetch = original
    expect(await auto!.install()).toBe(true)
    for (const url of ["https://example.com", `${gateway!.url}/v1/chat/completions`, `${gateway!.url}/__mik_auto/openai-evil/v1/chat/completions`, "https://api.openai.com.evil.test/v1/chat/completions", "https://api.openai.com:444/v1/chat/completions", "http://api.openai.com/v1/chat/completions", "https://user:pass@api.openai.com/v1/chat/completions"]) {
      const input = new URL(url); const init = { headers: { "x-test": "unaltered" } }
      expect(await (await fetch(input, init)).text()).toBe("direct")
      expect(original.mock.calls.at(-1)).toEqual([input, init])
    }
    auto!.restore(); expect(globalThis.fetch).toBe(original)
  })

  it("native JSON, error and transport-split SSE responses are redacted and remain parsable", async () => {
    await start(false, false, true); expect(await auto!.install()).toBe(true)
    const json = await (await fetch("https://api.anthropic.com/v1/messages", body("claude-test"))).json()
    expect(JSON.stringify(json)).toContain("sk-****"); expect(JSON.stringify(json)).not.toContain("sk-auto-leaked-999")
    auto!.restore(); await gateway!.close(); await hub!.close()
    await start(true, false, true); expect(await auto!.install()).toBe(true)
    const text = await (await fetch("https://api.anthropic.com/v1/messages", body("claude-test", true))).text()
    expect(text).not.toContain("sk-auto-leaked-999"); expect(text).toContain("sk-****")
    for (const line of text.split("\n").filter(line => line.startsWith("data:"))) expect(() => JSON.parse(line.slice(5))).not.toThrow()
    auto!.restore(); await gateway!.close(); await hub!.close()
    await start(false, false, true, true); expect(await auto!.install()).toBe(true)
    const response = await fetch("https://api.anthropic.com/v1/messages", body("claude-test"))
    expect(response.status).toBe(401)
    const error = await response.text(); expect(error).not.toContain("arbitrary-secret"); expect(error).not.toContain("sk-auto-leaked-999")
  })

  it("a gateway in the same process bypasses auto for its own whitelisted upstream fetch", async () => {
    await start()
    const upstreamTransport = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith("https://api.openai.com/")) return Response.json({ model: "unit-chat", choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } })
      return nativeFetch(input, init)
    })
    globalThis.fetch = upstreamTransport
    hub!.providers.add({ ...hub!.providers.get("vendor-a")!, baseUrl: "https://api.openai.com/v1" })
    expect(await auto!.install()).toBe(true)
    expect((await fetch("https://api.openai.com/v1/chat/completions", body("unit-chat"))).status).toBe(200)
    expect(upstreamTransport.mock.calls.filter(([input]) => String(input).startsWith("https://api.openai.com/"))).toHaveLength(1)
    expect(hub!.usage.query().total).toBe(1)
  })

  it("Request overrides, query, body and abort signal retain native fetch semantics", async () => {
    await start(); expect(await auto!.install()).toBe(true)
    const request = new Request("https://api.openai.com/v1/chat/completions?test=1", body("unit-chat"))
    const response = await fetch(request, { headers: { "content-type": "application/json", "x-extra": "yes" } })
    expect(response.status).toBe(200)
    expect(request.bodyUsed).toBe(true)
    expect(calls[0]!.path).toBe("/v1/chat/completions?test=1")
    expect(calls[0]!.headers["x-extra"]).toBe("yes")
    const controller = new AbortController(); controller.abort()
    await expect(fetch("https://api.openai.com/v1/chat/completions", { ...body("unit-chat"), signal: controller.signal })).rejects.toThrow()
  })

  it("preserves multipart boundaries and explicit native request options at the redirect transport", async () => {
    await start()
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.endsWith("/api/health")) return nativeFetch(input, init)
      const form = await request.formData()
      expect(form.get("payload")).toBe("hi")
      expect(request.cache).toBe("no-store"); expect(request.redirect).toBe("manual")
      return Response.json({ ok: true })
    })
    globalThis.fetch = transport; expect(await auto!.install()).toBe(true)
    const form = new FormData(); form.set("payload", "hi")
    expect((await fetch("https://api.openai.com/v1/unsupported", { method: "POST", body: form, cache: "no-store", redirect: "manual" })).status).toBe(200)
  })

  it("new generation endpoints enforce write:chat and reject unknown auto protocol markers", async () => {
    await start(); await gateway!.close()
    gateway = await createServer({ hub: hub!, port: 0, tokens: [{ token: "read-only-123", scopes: ["read:usage"] }, { token: "chat-only-123", scopes: ["write:chat"] }] })
    for (const path of ["messages", "responses"]) {
      const response = await nativeFetch(`${gateway.url}/v1/${path}`, { ...body("unit-chat"), headers: { "content-type": "application/json", authorization: "Bearer read-only-123" } })
      expect(response.status).toBe(403)
    }
    const response = await nativeFetch(`${gateway.url}/v1/chat/completions`, { ...body("unit-chat"), headers: { "content-type": "application/json", authorization: "Bearer chat-only-123", "x-mik-auto-protocol": "evil" } })
    expect(response.status).toBe(400); expect(calls).toHaveLength(0)
  })

  it("restore restores absence and prior environment exactly, is idempotent, and respects later host ownership", async () => {
    await start(); delete process.env.DEEPSEEK_BASE_URL; process.env.OPENAI_BASE_URL = "https://before.test/v1"
    expect(await auto!.install()).toBe(true)
    auto!.restore(); auto!.restore()
    expect(globalThis.fetch).toBe(nativeFetch)
    expect(process.env.OPENAI_BASE_URL).toBe("https://before.test/v1"); expect(process.env.DEEPSEEK_BASE_URL).toBeUndefined()
    expect(await auto!.install()).toBe(true)
    process.env.OPENAI_BASE_URL = "https://host-later.test"
    const later = vi.fn<typeof fetch>(); globalThis.fetch = later
    auto!.restore()
    expect(globalThis.fetch).toBe(later); expect(process.env.OPENAI_BASE_URL).toBe("https://host-later.test")
  })

  it("missing/unrelated/remote/redirected discovery leaves environment and fetch untouched", async () => {
    auto ??= await import("../src/auto.js")
    const baseKeys = ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "DEEPSEEK_BASE_URL"]
    const before = Object.fromEntries(baseKeys.map(key => [key, process.env[key]]))
    for (const url of ["http://127.0.0.1:1", "https://remote.test", "http://127.0.0.1:3211/private", "http://user:secret@localhost:3211"]) {
      process.env.MIK_GATEWAY_URL = url
      expect(await auto.install()).toBe(false); expect(globalThis.fetch).toBe(nativeFetch)
      for (const key of baseKeys) expect(process.env[key] === before[key]).toBe(true)
    }
    globalThis.fetch = vi.fn<typeof fetch>(async () => Response.json({ status: "ok", appId: "fake" }))
    process.env.MIK_GATEWAY_URL = "http://127.0.0.1:3211"
    const original = globalThis.fetch
    expect(await auto.install()).toBe(false); expect(globalThis.fetch).toBe(original)
  })
})
