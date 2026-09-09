import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestServer } from "@ai-sdk/test-server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ModelInfra, type ModelInfraOptions } from "../src/hub.js"
import type { ProviderConfig } from "../src/types.js"

const TEST_KEY = "sk-t05-fetch-testkey-5678"
const CALLER_KEY = "sk-caller-supplied-key-9999"
/** Where `mik.baseUrl` points; the server (T07) will bind this. */
const PUBLISHED = "http://127.0.0.1:3211/v1"

const COMPLETION = {
  id: "chatcmpl-fwd",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "deepseek-chat",
  choices: [{ index: 0, message: { role: "assistant", content: "forwarded" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 300,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens_details: { reasoning_tokens: 64 },
  },
}

const SSE_FRAMES = [
  `data: ${JSON.stringify({ id: "1", model: "deepseek-chat", choices: [{ index: 0, delta: { content: "for" }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: "1", model: "deepseek-chat", choices: [{ index: 0, delta: { content: "warded" }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({
    id: "1",
    model: "deepseek-chat",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
  })}\n\n`,
  "data: [DONE]\n\n",
]

const MODELS = {
  object: "list",
  data: [{ id: "deepseek-chat", object: "model", created: 1, owned_by: "mock" }],
}

const root = "https://mock-fwd.test/v1"

const server = createTestServer({
  [`${root}/fwd/chat/completions`]: { response: { type: "json-value", body: COMPLETION } },
  [`${root}/stream/chat/completions`]: {
    response: { type: "stream-chunks", chunks: SSE_FRAMES },
  },
  [`${root}/fail/chat/completions`]: {
    response: {
      type: "error",
      status: 401,
      body: JSON.stringify({ error: { message: `invalid api key ${TEST_KEY}` } }),
    },
  },
  [`${root}/fwd/models`]: { response: { type: "json-value", body: MODELS } },
})

const offlineFetch = (async () => {
  throw new Error("network disabled in tests")
}) as unknown as typeof globalThis.fetch

const hubs: ModelInfra[] = []
let cacheDir = ""
let warnings: string[] = []

beforeAll(() => {
  server.server.start()
  cacheDir = mkdtempSync(join(tmpdir(), "mik-t05-fetch-"))
  process.env.MIK_T05_FETCH_KEY = TEST_KEY
})

afterAll(() => {
  server.server.stop()
  delete process.env.MIK_T05_FETCH_KEY
})

beforeEach(() => {
  server.server.reset()
  warnings = []
})

afterEach(() => {
  while (hubs.length > 0) hubs.pop()?.close()
})

function provider(id: string, baseUrl = `${root}/${id}`): ProviderConfig {
  return { id, baseUrl, apiKeyRef: "env:MIK_T05_FETCH_KEY", enabled: true }
}

async function makeHub(options: ModelInfraOptions = {}): Promise<ModelInfra> {
  const hub = await ModelInfra.init({
    appId: "t05-fetch",
    db: ":memory:",
    cacheDir,
    pricingFetch: offlineFetch,
    syncCatalog: false,
    baseUrl: PUBLISHED,
    providers: [provider("fwd"), provider("stream"), provider("fail"), provider("dead", "http://127.0.0.1:1/v1")],
    defaultModel: "fwd:deepseek-chat",
    onWarn: (message) => warnings.push(message),
    ...options,
  })
  hubs.push(hub)
  return hub
}

function chatRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }
}

describe("mik.fetch", () => {
  it("forwards an OpenAI-compatible request to the configured provider", async () => {
    const hub = await makeHub()
    expect(hub.baseUrl).toBe(PUBLISHED)

    const response = await hub.fetch(
      `${hub.baseUrl}/chat/completions`,
      chatRequest({ model: "fwd:deepseek-chat", messages: [{ role: "user", content: "hi" }] }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(COMPLETION)

    const call = server.calls.find((entry) => entry.requestUrl.endsWith("/fwd/chat/completions"))!
    expect(call).toBeDefined()
    expect(call.requestMethod).toBe("POST")
    expect(call.requestHeaders.authorization).toBe(`Bearer ${TEST_KEY}`)
    // Our internal `provider:model` reference never reaches the provider.
    expect(await call.requestBodyJson).toMatchObject({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hi" }],
    })
  })

  it("records the usage the provider reported, priced", async () => {
    const hub = await makeHub()
    await hub.fetch(`${hub.baseUrl}/chat/completions`, chatRequest({ model: "fwd:deepseek-chat", messages: [] }))

    const page = hub.usage.query()
    expect(page.total).toBe(1)
    const event = page.events[0]!
    expect(event).toMatchObject({
      appId: "t05-fetch",
      source: "fetch",
      providerId: "fwd",
      modelRequested: "fwd:deepseek-chat",
      modelActual: "deepseek-chat",
      status: "ok",
      isStreaming: false,
    })
    expect(event.usage).toEqual({ input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 })
    expect(event.cost.source).toBe("fallback")
    expect(event.cost.usd).toBeGreaterThan(0)
    expect(event.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("routes a bare model id through the default provider", async () => {
    const hub = await makeHub()
    await hub.fetch(`${hub.baseUrl}/chat/completions`, chatRequest({ model: "deepseek-reasoner", messages: [] }))

    const call = server.calls.find((entry) => entry.requestUrl.endsWith("/fwd/chat/completions"))!
    expect(await call.requestBodyJson).toMatchObject({ model: "deepseek-reasoner" })
    expect(hub.usage.query().events[0]).toMatchObject({ providerId: "fwd", modelActual: "deepseek-chat" })
  })

  it("replaces a caller-supplied credential with the configured one", async () => {
    const hub = await makeHub()
    await hub.fetch(
      `${hub.baseUrl}/chat/completions`,
      chatRequest({ model: "fwd:deepseek-chat", messages: [] }, { authorization: `Bearer ${CALLER_KEY}` }),
    )

    const call = server.calls.find((entry) => entry.requestUrl.endsWith("/fwd/chat/completions"))!
    expect(call.requestHeaders.authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(JSON.stringify(server.calls.map((entry) => entry.requestUrl))).not.toContain(CALLER_KEY)
  })

  it("streams a response through unchanged and still meters it", async () => {
    const hub = await makeHub()
    const response = await hub.fetch(
      `${hub.baseUrl}/chat/completions`,
      chatRequest({ model: "stream:deepseek-chat", messages: [], stream: true }),
    )

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(await response.text()).toBe(SSE_FRAMES.join(""))

    const event = hub.usage.query().events[0]!
    expect(event).toMatchObject({ source: "fetch", isStreaming: true, status: "ok", modelActual: "deepseek-chat" })
    expect(event.usage).toEqual({ input: 40, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(event.firstTokenMs).toBeGreaterThanOrEqual(0)
  })

  it("passes a non-generation request through without metering it", async () => {
    const hub = await makeHub()
    const response = await hub.fetch(`${hub.baseUrl}/models`, { method: "GET" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(MODELS)
    expect(hub.usage.query().total).toBe(0)
  })

  it("answers 400 for an unknown provider and records nothing", async () => {
    const hub = await makeHub()
    const response = await hub.fetch(`${hub.baseUrl}/chat/completions`, chatRequest({ model: "ghost:m", messages: [] }))

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: "PROVIDER_NOT_FOUND" } })
    expect(hub.usage.query().total).toBe(0)
  })

  it("answers 400 when no model can be resolved", async () => {
    const hub = await makeHub({ defaultModel: undefined })
    const response = await hub.fetch(`${hub.baseUrl}/chat/completions`, chatRequest({ messages: [] }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } })
    expect(hub.usage.query().total).toBe(0)
  })

  it("answers 400 for a body that is not JSON", async () => {
    const hub = await makeHub()
    const response = await hub.fetch(`${hub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    })
    expect(response.status).toBe(400)
    expect(hub.usage.query().total).toBe(0)
  })

  it("returns the upstream error and records it without leaking the key", async () => {
    const hub = await makeHub()
    const response = await hub.fetch(`${hub.baseUrl}/chat/completions`, chatRequest({ model: "fail:deepseek-chat", messages: [] }))

    expect(response.status).toBe(401)
    expect(await response.text()).toContain("invalid api key")

    const page = hub.usage.query()
    expect(page.total).toBe(1)
    expect(page.events[0]).toMatchObject({ status: "error", errorCode: "AUTH", source: "fetch" })
    expect(JSON.stringify({ page, warnings })).not.toContain(TEST_KEY)
  })

  it("answers 502 and records a connection failure when the provider is down", async () => {
    const hub = await makeHub()
    const response = await hub.fetch(`${hub.baseUrl}/chat/completions`, chatRequest({ model: "dead:deepseek-chat", messages: [] }))

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: "CONNECTION" } })
    expect(hub.usage.query().events[0]).toMatchObject({ status: "error", errorCode: "CONNECTION", providerId: "dead" })
  })

  it("works when the caller passes a Request object", async () => {
    const hub = await makeHub()
    const request = new Request(`${hub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fwd:deepseek-chat", messages: [] }),
    })
    const response = await hub.fetch(request)
    expect(response.status).toBe(200)
    expect(hub.usage.query().total).toBe(1)
  })
})
