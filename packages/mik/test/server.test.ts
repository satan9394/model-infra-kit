import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestServer } from "@ai-sdk/test-server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelInfra, type ModelInfraOptions, type ProviderConfig } from "../src/index.js"
import {
  createServer,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type ServerHandle,
} from "../src/server/index.js"

const TEST_KEY = "sk-t07-server-testkey-1234"
const TOKEN = "t07-bearer-token-abcdef"

/** The shape `docs/verified-facts.md` §1 recorded from a real run. */
const COMPLETION = {
  id: "chatcmpl-t07",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "deepseek-chat",
  choices: [{ index: 0, message: { role: "assistant", content: "hello from the hub" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 300,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens_details: { reasoning_tokens: 64 },
  },
}

/** An upstream answer that asks the caller to run one tool (F07). */
const TOOL_COMPLETION = {
  id: "chatcmpl-t07-tool",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "deepseek-chat",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_weather_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
}

/** The OpenAI tool definition every F07 test sends. */
const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Look up the weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
}

function sse(...frames: string[]): string[] {
  return frames.map((frame) => `data: ${frame}\n\n`)
}

const STREAM_CHUNKS = sse(
  JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-chat",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  }),
  JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-chat",
    choices: [{ index: 0, delta: { content: "hello " }, finish_reason: null }],
  }),
  JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-chat",
    choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
  }),
  JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-chat",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
  }),
  "[DONE]",
)

const MODELS = {
  object: "list",
  data: [
    { id: "deepseek-chat", object: "model", created: 1, owned_by: "mock" },
    { id: "deepseek-reasoner", object: "model", created: 2, owned_by: "mock" },
  ],
}

const root = "https://mock-t07.test/v1"

const mock = createTestServer({
  [`${root}/ok/chat/completions`]: { response: { type: "json-value", body: COMPLETION } },
  // A second non-streaming provider, so a header-routed request is distinguishable.
  [`${root}/ok2/chat/completions`]: { response: { type: "json-value", body: COMPLETION } },
  [`${root}/str/chat/completions`]: {
    response: { type: "stream-chunks", headers: { "content-type": "text/event-stream" }, chunks: STREAM_CHUNKS },
  },
  [`${root}/bad/chat/completions`]: { response: { type: "error", status: 500, body: "upstream exploded" } },
  [`${root}/ok/models`]: { response: { type: "json-value", body: MODELS } },
  [`${root}/ok2/models`]: { response: { type: "json-value", body: MODELS } },
  [`${root}/str/models`]: { response: { type: "json-value", body: MODELS } },
  [`${root}/bad/models`]: { response: { type: "error", status: 500, body: "no catalogue" } },
})

/** No test may reach the network: the catalogue load always fails here. */
const offlineFetch = (async () => {
  throw new Error("network disabled in tests")
}) as unknown as typeof globalThis.fetch

interface ErrorBody {
  error: { message: string; type: string; code: string }
}

interface OpenAiCompletion {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: string; content: string | null; tool_calls?: unknown[] }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details: { cached_tokens: number }
    completion_tokens_details: { reasoning_tokens: number }
  }
  x_modelhub: {
    provider: string
    model_requested: string
    cost_usd: number
    cost_source: string
    latency_ms: number
    first_token_ms: number | null
    steps: number
  }
}

interface StreamChunk {
  id: string
  object: string
  model: string
  choices: Array<{ index: number; delta: { role?: string; content?: string }; finish_reason: string | null }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

let cacheDir = ""
let warnings: string[] = []
let hub: ModelInfra
let handle: ServerHandle

beforeAll(() => {
  mock.server.start()
  cacheDir = mkdtempSync(join(tmpdir(), "mik-t07-"))
  process.env.MIK_T07_SERVER_KEY = TEST_KEY
})

afterAll(() => {
  mock.server.stop()
  delete process.env.MIK_T07_SERVER_KEY
})

beforeEach(async () => {
  mock.server.reset()
  warnings = []
  hub = await makeHub()
  handle = await createServer({ hub, port: 0, token: TOKEN, heartbeatMs: 30 })
})

afterEach(async () => {
  await handle.close()
  hub.close()
})

function provider(id: string): ProviderConfig {
  return { id, baseUrl: `${root}/${id}`, apiKeyRef: "env:MIK_T07_SERVER_KEY", enabled: true }
}

async function makeHub(options: ModelInfraOptions = {}): Promise<ModelInfra> {
  return ModelInfra.init({
    appId: "t07-app",
    db: ":memory:",
    cacheDir,
    pricingFetch: offlineFetch,
    syncCatalog: false,
    // The SDK's own retry loop would add seconds to every failure case.
    maxRetries: 0,
    providers: ["ok", "ok2", "str", "bad"].map(provider),
    defaultModel: "ok:deepseek-chat",
    onWarn: (message) => warnings.push(message),
    ...options,
  })
}

function url(path: string): string {
  return `${handle.url}${path}`
}

async function api(path: string, init: RequestInit = {}, token: string | null = TOKEN): Promise<Response> {
  const headers = new Headers(init.headers)
  if (token !== null) headers.set("authorization", `Bearer ${token}`)
  return fetch(url(path), { ...init, headers })
}

async function post(path: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, token)
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function chat(bodyValue: unknown, token: string | null = TOKEN): Promise<Response> {
  return post("/v1/chat/completions", bodyValue, token)
}

function messages(): unknown[] {
  return [{ role: "user", content: "hi" }]
}

/** The JSON the mock provider actually received for call `index` (F07). */
async function upstreamBody(index = 0): Promise<Record<string, unknown>> {
  const call = mock.calls[index]
  if (!call) throw new Error(`no upstream call was recorded at index ${index}`)
  return (await call.requestBodyJson) as Record<string, unknown>
}

/** Split an SSE body into its `data:` payloads, `[DONE]` included. */
function sseFrames(text: string): string[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice(6))
}

/** Pump an SSE response into a string buffer that can be awaited on. */
function pump(response: Response): { text: () => string; waitFor: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string> } {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
      }
    } catch {
      // Aborted by the test.
    }
  })()

  return {
    text: () => buffer,
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate(buffer)) return buffer
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`timed out waiting for an SSE frame; received: ${JSON.stringify(buffer)}`)
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for a condition")
}

/** Every `$ref` in the OpenAPI document, with the path it was found at. */
function collectRefs(value: unknown, path = "$"): Array<{ ref: string; path: string }> {
  if (Array.isArray(value)) return value.flatMap((item, index) => collectRefs(item, `${path}[${index}]`))
  if (!value || typeof value !== "object") return []
  const found: Array<{ ref: string; path: string }> = []
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof item === "string") found.push({ ref: item, path })
    else found.push(...collectRefs(item, `${path}.${key}`))
  }
  return found
}

describe("createServer", () => {
  it("binds an ephemeral port, publishes its url and points the hub at it", async () => {
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`)
    expect(handle.host).toBe("127.0.0.1")
    expect(hub.baseUrl).toBe(`${handle.url}/v1`)

    const response = await fetch(url("/api/health"))
    expect(response.status).toBe(200)
    const health = await body<{ status: string; appId: string; baseUrl: string; origin: string; providers: number }>(response)
    expect(health.status).toBe("ok")
    expect(health.appId).toBe("t07-app")
    expect(health.origin).toBe(handle.url)
    expect(health.baseUrl).toBe(`${handle.url}/v1`)
    expect(health.providers).toBe(4)
  })

  it("defaults to 127.0.0.1:3211 with a 15s heartbeat", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1")
    expect(DEFAULT_PORT).toBe(3211)
    expect(DEFAULT_HEARTBEAT_MS).toBe(15_000)
  })

  it("refuses to steal a port that is already in use", async () => {
    const blocker = await createServer({ hub, port: 0, heartbeatMs: 0 })
    await expect(createServer({ hub, port: blocker.port })).rejects.toThrow(/already in use.*netstat/)
    await blocker.close()
  })

  it("answers unknown paths with 404 and wrong methods with 405", async () => {
    const missing = await api("/api/nope")
    expect(missing.status).toBe(404)
    expect((await body<ErrorBody>(missing)).error.code).toBe("NOT_FOUND")

    const wrongMethod = await api("/api/health", { method: "DELETE" })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("GET")
    expect((await body<ErrorBody>(wrongMethod)).error.code).toBe("METHOD_NOT_ALLOWED")
  })

  it("adds CORS headers only when asked", async () => {
    const plain = await api("/api/providers")
    expect(plain.headers.get("access-control-allow-origin")).toBeNull()

    const corsHandle = await createServer({ hub, port: 0, cors: true, heartbeatMs: 0 })
    const preflight = await fetch(`${corsHandle.url}/api/providers`, { method: "OPTIONS" })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization")

    const get = await fetch(`${corsHandle.url}/api/providers`)
    expect(get.headers.get("access-control-allow-origin")).toBe("*")
    await corsHandle.close()
  })
})

describe("auth", () => {
  it("requires a bearer token everywhere except /api/health", async () => {
    const health = await fetch(url("/api/health"))
    expect(health.status).toBe(200)

    for (const path of ["/api/providers", "/api/usage/summary", "/openapi.json", "/v1/models"]) {
      const anonymous = await fetch(url(path))
      expect(anonymous.status, path).toBe(401)
      expect(anonymous.headers.get("www-authenticate")).toContain("Bearer")
      const payload = await body<ErrorBody>(anonymous)
      expect(payload.error.code).toBe("AUTH")
      expect(payload.error.type).toBe("invalid_request_error")
      expect(JSON.stringify(payload)).not.toContain(TOKEN)
      expect(JSON.stringify(payload)).not.toContain("Bearer ")
    }

    const wrong = await api("/api/providers", {}, "wrong-token")
    expect(wrong.status).toBe(401)

    const malformed = await fetch(url("/api/providers"), { headers: { authorization: TOKEN } })
    expect(malformed.status).toBe(401)

    const good = await api("/api/providers")
    expect(good.status).toBe(200)
  })

  it("never echoes the expected token or a provider secret", async () => {
    await hub.generate({ model: "ok:deepseek-chat", messages: [{ role: "user", content: "hi" }] })
    const seen = JSON.stringify({
      providers: await body(await api("/api/providers")),
      logs: await body(await api("/api/usage/logs")),
      models: await body(await api("/api/models")),
      openapi: await body(await api("/openapi.json")),
    })
    expect(seen).not.toContain(TOKEN)
    expect(seen).not.toContain(TEST_KEY)
    expect(seen).toContain("env:MIK_T07_SERVER_KEY")
  })

  it("serves without a token when none is configured", async () => {
    const open = await createServer({ hub, port: 0, heartbeatMs: 0 })
    const response = await fetch(`${open.url}/api/providers`)
    expect(response.status).toBe(200)
    await open.close()
  })
})

describe("POST /v1/chat/completions", () => {
  it("returns an OpenAI completion and records exactly one usage row", async () => {
    const response = await chat({ model: "ok:deepseek-chat", messages: messages() })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")

    const completion = await body<OpenAiCompletion>(response)
    expect(completion.object).toBe("chat.completion")
    expect(completion.id).toMatch(/^chatcmpl-/)
    expect(completion.model).toBe("deepseek-chat")
    expect(completion.choices).toHaveLength(1)
    expect(completion.choices[0]!.message).toEqual({ role: "assistant", content: "hello from the hub" })
    expect(completion.choices[0]!.finish_reason).toBe("stop")
    expect(completion.usage).toMatchObject({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 })
    expect(completion.usage.prompt_tokens_details.cached_tokens).toBe(800)
    expect(completion.usage.completion_tokens_details.reasoning_tokens).toBe(64)
    expect(completion.x_modelhub).toMatchObject({ provider: "ok", model_requested: "ok:deepseek-chat", steps: 1 })
    expect(completion.x_modelhub.cost_usd).toBeGreaterThan(0)

    // Exactly one row, from the HTTP entry point, non-streaming.
    const page = hub.usage.query()
    expect(page.total).toBe(1)
    expect(page.events[0]).toMatchObject({
      appId: "t07-app",
      source: "generate",
      providerId: "ok",
      modelActual: "deepseek-chat",
      status: "ok",
      isStreaming: false,
      tags: { entrypoint: "openai-http" },
    })
    expect(page.events[0]!.usage).toEqual({ input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 })
    expect(mock.calls.filter((call) => call.requestUrl.endsWith("/ok/chat/completions"))).toHaveLength(1)
  })

  it("routes a bare model id through the X-ModelHub-Provider header", async () => {
    const withHeader = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-modelhub-provider": "ok2" },
      body: JSON.stringify({ model: "deepseek-chat", messages: messages() }),
    })
    expect(withHeader.status).toBe(200)
    const rows = hub.usage.query().events
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ providerId: "ok2", modelRequested: "ok2:deepseek-chat" })

    // Without the header the same bare id goes through the default provider.
    expect((await chat({ model: "deepseek-chat", messages: messages() })).status).toBe(200)
    expect(hub.usage.query().events.map((event) => event.providerId)).toEqual(["ok", "ok2"])
  })

  it("falls back to the configured default model", async () => {
    const response = await chat({ messages: messages() })
    expect(response.status).toBe(200)
    expect((await body<OpenAiCompletion>(response)).x_modelhub.model_requested).toBe("ok:deepseek-chat")
  })

  it("records the OpenAI user field as the session id", async () => {
    await chat({ model: "ok:deepseek-chat", messages: messages(), user: "alice" })
    expect(hub.usage.query().events[0]).toMatchObject({ sessionId: "alice" })
  })

  it("streams OpenAI chunks and records one streaming row", async () => {
    const response = await chat({ model: "str:deepseek-chat", messages: messages(), stream: true })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const text = await response.text()
    const frames = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => frame.slice(6))
    expect(frames.at(-1)).toBe("[DONE]")
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame) as StreamChunk)
    expect(chunks[0]).toMatchObject({ object: "chat.completion.chunk", model: "deepseek-chat" })
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: "assistant" })
    expect(chunks.map((chunk) => chunk.choices[0]!.delta.content ?? "").join("")).toBe("hello world")
    const last = chunks.at(-1)!
    expect(last.choices[0]!.finish_reason).toBe("stop")
    expect(last.usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 })

    const page = hub.usage.query()
    expect(page.total).toBe(1)
    expect(page.events[0]).toMatchObject({
      source: "stream",
      isStreaming: true,
      status: "ok",
      modelActual: "deepseek-chat",
      appId: "t07-app",
    })
    expect(page.events[0]!.usage).toEqual({ input: 40, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  })

  it("maps an unroutable model onto a 404 before any byte is streamed", async () => {
    const plain = await chat({ model: "ghost:model", messages: messages() })
    expect(plain.status).toBe(404)
    expect((await body<ErrorBody>(plain)).error.code).toBe("PROVIDER_NOT_FOUND")

    const streaming = await chat({ model: "ghost:model", messages: messages(), stream: true })
    expect(streaming.status).toBe(404)
    expect(streaming.headers.get("content-type")).toContain("application/json")
    expect((await body<ErrorBody>(streaming)).error.code).toBe("PROVIDER_NOT_FOUND")

    // A request that could never be routed is not metered.
    expect(hub.usage.query().total).toBe(0)
  })

  it("maps a provider failure onto an OpenAI error with the right status", async () => {
    const plain = await chat({ model: "bad:deepseek-chat", messages: messages() })
    expect(plain.status).toBe(502)
    const payload = await body<ErrorBody>(plain)
    expect(payload.error.code).toBe("PROVIDER")
    expect(payload.error.type).toBe("server_error")
    expect(payload.error.message).not.toContain(TEST_KEY)

    const streaming = await chat({ model: "bad:deepseek-chat", messages: messages(), stream: true })
    expect(streaming.status).toBe(502)
    expect((await body<ErrorBody>(streaming)).error.code).toBe("PROVIDER")

    const rows = hub.usage.query().events
    expect(rows).toHaveLength(2)
    expect(rows.every((event) => event.status === "error" && event.errorCode === "PROVIDER")).toBe(true)
  })

  it("rejects malformed bodies with 400", async () => {
    const notJson = await api("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    })
    expect(notJson.status).toBe(400)
    expect((await body<ErrorBody>(notJson)).error.code).toBe("INVALID_REQUEST")

    const noMessages = await chat({ model: "ok:deepseek-chat" })
    expect(noMessages.status).toBe(400)
    expect((await body<ErrorBody>(noMessages)).error.message).toContain("messages")

    const emptyMessages = await chat({ model: "ok:deepseek-chat", messages: [] })
    expect(emptyMessages.status).toBe(400)

    const badRole = await chat({ model: "ok:deepseek-chat", messages: [{ role: "wizard", content: "hi" }] })
    expect(badRole.status).toBe(400)
    expect((await body<ErrorBody>(badRole)).error.message).toContain("role")

    expect(hub.usage.query().total).toBe(0)
  })
})

describe("GET /v1/models", () => {
  it("lists the stored catalogue in OpenAI's shape", async () => {
    const refreshed = await api("/api/providers/ok/models/refresh", { method: "POST" })
    expect(refreshed.status).toBe(200)

    const list = await body<{ object: string; data: Array<{ id: string; object: string; owned_by: string; created: number }> }>(
      await api("/v1/models"),
    )
    expect(list.object).toBe("list")
    expect(list.data.map((model) => model.id)).toEqual(["ok:deepseek-chat", "ok:deepseek-reasoner"])
    expect(list.data[0]).toMatchObject({ object: "model", owned_by: "ok" })
    expect(list.data[0]!.created).toBeGreaterThan(0)

    const filtered = await body<{ data: unknown[] }>(await api("/v1/models?provider=str"))
    expect(filtered.data).toEqual([])
  })
})

describe("/api/providers", () => {
  it("lists, adds, patches and removes providers", async () => {
    const initial = await body<{ providers: Array<{ id: string; apiKeyRef?: string }> }>(await api("/api/providers"))
    expect(initial.providers.map((item) => item.id)).toEqual(["bad", "ok", "ok2", "str"])
    expect(initial.providers.find((item) => item.id === "ok")?.apiKeyRef).toBe("env:MIK_T07_SERVER_KEY")

    const created = await post("/api/providers", {
      id: "extra",
      baseUrl: `${root}/ok`,
      apiKeyRef: "env:MIK_T07_SERVER_KEY",
      enabled: false,
    })
    expect(created.status).toBe(201)
    const added = await body<{ provider: { id: string; protocol: string; enabled: boolean } }>(created)
    expect(added.provider).toMatchObject({ id: "extra", protocol: "openai-compatible", enabled: false })

    const patched = await api("/api/providers/extra", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, name: "Extra provider" }),
    })
    expect(patched.status).toBe(200)
    expect(await body<{ provider: { enabled: boolean; name: string; baseUrl: string } }>(patched)).toMatchObject({
      provider: { enabled: true, name: "Extra provider", baseUrl: `${root}/ok` },
    })

    const removed = await api("/api/providers/extra", { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect(await body<{ deleted: boolean }>(removed)).toEqual({ deleted: true, id: "extra" })

    expect((await api("/api/providers/extra", { method: "DELETE" })).status).toBe(404)
    expect((await api("/api/providers/ghost", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404)
  })

  it("rejects an invalid provider configuration", async () => {
    expect((await post("/api/providers", { baseUrl: "https://x.test" })).status).toBe(400)
    const badProtocol = await post("/api/providers", { id: "x", protocol: "carrier-pigeon" })
    expect(badProtocol.status).toBe(400)
    expect((await body<ErrorBody>(badProtocol)).error.message).toContain("protocol")
    const badId = await post("/api/providers", { id: "has:colon" })
    expect(badId.status).toBe(400)
  })

  it("tests a provider and reports the model count", async () => {
    const response = await api("/api/providers/ok/test", { method: "POST" })
    expect(response.status).toBe(200)
    const result = await body<{ status: { providerId: string; ok: boolean; modelCount: number; message: string } }>(response)
    expect(result.status).toMatchObject({ providerId: "ok", ok: true, modelCount: 2 })

    const failing = await body<{ status: { ok: boolean; message: string } }>(await api("/api/providers/bad/test", { method: "POST" }))
    expect(failing.status.ok).toBe(false)
    expect(failing.status.message).not.toContain(TEST_KEY)

    expect((await api("/api/providers/ghost/test", { method: "POST" })).status).toBe(404)
  })

  it("lists and refreshes the catalogue of one provider", async () => {
    expect(await body<{ models: unknown[] }>(await api("/api/providers/ok/models"))).toEqual({ models: [] })

    const refreshed = await api("/api/providers/ok/models/refresh", { method: "POST" })
    expect(refreshed.status).toBe(200)
    const models = await body<{ models: Array<{ ref: string }> }>(refreshed)
    expect(models.models.map((model) => model.ref)).toEqual(["ok:deepseek-chat", "ok:deepseek-reasoner"])

    expect(await body<{ models: unknown[] }>(await api("/api/providers/ok/models"))).toHaveProperty("models.length", 2)
    expect((await api("/api/providers/ghost/models")).status).toBe(404)
    expect((await api("/api/providers/ghost/models/refresh", { method: "POST" })).status).toBe(404)
  })
})

describe("/api/models", () => {
  it("lists every model and gets one by reference", async () => {
    await api("/api/providers/ok/models/refresh", { method: "POST" })

    const all = await body<{ models: Array<{ ref: string }> }>(await api("/api/models"))
    expect(all.models.map((model) => model.ref)).toEqual(["ok:deepseek-chat", "ok:deepseek-reasoner"])

    const one = await api("/api/models/ok:deepseek-chat")
    expect(one.status).toBe(200)
    const model = await body<{ model: { ref: string; providerId: string; modelId: string; pricing?: { source: string } } }>(one)
    expect(model.model).toMatchObject({ ref: "ok:deepseek-chat", providerId: "ok", modelId: "deepseek-chat" })
    expect(model.model.pricing?.source).toBe("fallback")

    expect((await api("/api/models/ok:not-there")).status).toBe(404)
    expect((await api(`/api/models/${encodeURIComponent("ok:deepseek-chat")}`)).status).toBe(200)
  })
})

describe("/api/pricing", () => {
  it("reads state, sets and removes a manual price, and syncs", async () => {
    const initial = await body<{ state: { status: string }; overrides: unknown[] }>(await api("/api/pricing"))
    expect(["fresh", "stale", "error"]).toContain(initial.state.status)
    expect(initial.overrides).toEqual([])

    const set = await api("/api/pricing/deepseek-chat", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputPerM: 0.5, outputPerM: 1.5, displayName: "negotiated" }),
    })
    expect(set.status).toBe(200)
    expect(await body<{ override: { modelId: string; inputPerM: number; displayName: string } }>(set)).toMatchObject({
      override: { modelId: "deepseek-chat", inputPerM: 0.5, displayName: "negotiated" },
    })

    const listed = await body<{ overrides: Array<{ modelId: string }> }>(await api("/api/pricing"))
    expect(listed.overrides.map((item) => item.modelId)).toEqual(["deepseek-chat"])

    const invalid = await api("/api/pricing/deepseek-chat", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "no rates" }),
    })
    expect(invalid.status).toBe(400)
    expect((await body<ErrorBody>(invalid)).error.code).toBe("INVALID_REQUEST")

    const removed = await api("/api/pricing/deepseek-chat", { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect((await api("/api/pricing/deepseek-chat", { method: "DELETE" })).status).toBe(404)

    const sync = await api("/api/pricing/sync", { method: "POST" })
    expect(sync.status).toBe(200)
    expect(["fresh", "stale", "error"]).toContain((await body<{ state: { status: string } }>(sync)).state.status)
  })
})

describe("/api/usage", () => {
  async function twoCalls(): Promise<void> {
    await chat({ model: "ok:deepseek-chat", messages: messages() })
    await chat({ model: "bad:deepseek-chat", messages: messages() })
  }

  it("summarises the recorded calls", async () => {
    await twoCalls()
    const summary = await body<{ summary: Record<string, unknown> }>(await api("/api/usage/summary"))
    expect(summary.summary).toMatchObject({ requests: 2, successes: 1, failures: 1, successRate: 0.5 })
    expect((summary.summary as { tokens: { input: number } }).tokens.input).toBe(1200)

    const filtered = await body<{ summary: { requests: number } }>(await api("/api/usage/summary?status=ok"))
    expect(filtered.summary.requests).toBe(1)
    const byProvider = await body<{ summary: { requests: number } }>(await api("/api/usage/summary?provider=bad"))
    expect(byProvider.summary.requests).toBe(1)
  })

  it("groups by provider, model and day or hour", async () => {
    await twoCalls()

    const providers = await body<{ buckets: Array<{ key: string; requests: number }> }>(await api("/api/usage/by-provider"))
    expect(providers.buckets.map((bucket) => bucket.key).sort()).toEqual(["bad", "ok"])

    const models = await body<{ buckets: Array<{ key: string; requests: number }> }>(await api("/api/usage/by-model"))
    expect(models.buckets).toHaveLength(1)
    expect(models.buckets[0]).toMatchObject({ key: "deepseek-chat", requests: 2 })

    const daily = await body<{ bucket: string; points: Array<{ date: string; requests: number }> }>(
      await api("/api/usage/trends"),
    )
    expect(daily.bucket).toBe("day")
    expect(daily.points).toHaveLength(1)
    expect(daily.points[0]!.requests).toBe(2)

    const hourly = await body<{ bucket: string; points: unknown[] }>(await api("/api/usage/trends?bucket=hour"))
    expect(hourly.bucket).toBe("hour")
    expect(hourly.points).toHaveLength(1)

    expect((await api("/api/usage/trends?bucket=week")).status).toBe(400)
  })

  it("pages and filters the detail log", async () => {
    await twoCalls()

    const page = await body<{ total: number; limit: number; offset: number; events: Array<{ requestId: string }> }>(
      await api("/api/usage/logs"),
    )
    expect(page).toMatchObject({ total: 2, limit: 50, offset: 0 })
    expect(page.events).toHaveLength(2)

    const limited = await body<{ total: number; events: unknown[] }>(await api("/api/usage/logs?limit=1&offset=1"))
    expect(limited.total).toBe(2)
    expect(limited.events).toHaveLength(1)

    const errors = await body<{ total: number; events: Array<{ status: string }> }>(await api("/api/usage/logs?status=error"))
    expect(errors.total).toBe(1)
    expect(errors.events[0]!.status).toBe("error")

    const byProvider = await body<{ total: number }>(await api("/api/usage/logs?provider=ok"))
    expect(byProvider.total).toBe(1)

    const byModel = await body<{ total: number }>(await api("/api/usage/logs?model=deepseek-chat"))
    expect(byModel.total).toBe(2)

    const future = new Date(Date.now() + 3_600_000).toISOString()
    const none = await body<{ total: number }>(await api(`/api/usage/logs?from=${encodeURIComponent(future)}`))
    expect(none.total).toBe(0)

    const since = new Date(Date.now() - 3_600_000).toISOString()
    const recent = await body<{ total: number }>(await api(`/api/usage/logs?from=${encodeURIComponent(since)}`))
    expect(recent.total).toBe(2)

    const epoch = await body<{ total: number }>(await api(`/api/usage/logs?from=${Date.now() - 3_600_000}&to=${Date.now() + 1000}`))
    expect(epoch.total).toBe(2)

    for (const query of ["from=yesterday", "limit=-1", "status=maybe", "offset=abc"]) {
      expect((await api(`/api/usage/logs?${query}`)).status, query).toBe(400)
    }
  })

  it("keeps another app's usage invisible (B1 through the HTTP surface)", async () => {
    const recorded = hub.usage.record({
      requestId: "other-app-request",
      appId: "other-app",
      ts: Date.now(),
      source: "generate",
      providerId: "ok",
      modelRequested: "ok:deepseek-chat",
      modelActual: "deepseek-chat",
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usd: 0.001, low: 0.001, high: 0.001, basis: "flat", source: "missing" },
      status: "ok",
      isStreaming: false,
    })
    expect(recorded).toBe(true)

    expect((await api("/api/usage/logs/other-app-request")).status).toBe(404)
    expect((await body<{ total: number }>(await api("/api/usage/logs"))).total).toBe(0)
    expect((await body<{ summary: { requests: number } }>(await api("/api/usage/summary"))).summary.requests).toBe(0)
  })

  it("gets one event by request id and hides unknown ids", async () => {
    await chat({ model: "ok:deepseek-chat", messages: messages() })
    const id = hub.usage.query().events[0]!.requestId

    const found = await api(`/api/usage/logs/${id}`)
    expect(found.status).toBe(200)
    expect(await body<{ event: { requestId: string; source: string } }>(found)).toMatchObject({
      event: { requestId: id, source: "generate" },
    })

    const missing = await api("/api/usage/logs/does-not-exist")
    expect(missing.status).toBe(404)
    expect((await body<ErrorBody>(missing)).error.code).toBe("NOT_FOUND")
  })
})

describe("GET /api/events", () => {
  it("streams usage, catalogue and price events, then cleans up on disconnect", async () => {
    const controller = new AbortController()
    const response = await fetch(url("/api/events"), {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const stream = pump(response)
    await stream.waitFor((text) => text.includes(": connected"))
    await stream.waitFor((text) => text.includes(": ping"))
    expect(handle.sseClients).toBe(1)

    await hub.generate({ model: "ok:deepseek-chat", messages: [{ role: "user", content: "hi" }] })
    const usage = await stream.waitFor((text) => text.includes("event: usage.recorded"))
    expect(usage).toContain('"type":"usage.recorded"')
    expect(usage).toContain('"appId":"t07-app"')
    expect(usage).toContain('"source":"generate"')

    await api("/api/providers/ok/models/refresh", { method: "POST" })
    await stream.waitFor((text) => text.includes("event: catalog.updated"))
    expect(stream.text()).toContain('"providerId":"ok"')

    await api("/api/pricing/deepseek-chat", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputPerM: 1 }),
    })
    await stream.waitFor((text) => text.includes("event: pricing.updated"))

    controller.abort()
    await waitFor(() => handle.sseClients === 0)
  })

  it("requires the bearer token", async () => {
    const response = await fetch(url("/api/events"))
    expect(response.status).toBe(401)
  })
})

describe("GET /openapi.json", () => {
  const CONTRACT_PATHS = [
    "/api/health",
    "/api/providers",
    "/api/providers/{id}",
    "/api/providers/{id}/test",
    "/api/providers/{id}/models",
    "/api/providers/{id}/models/refresh",
    "/api/models",
    "/api/models/{ref}",
    "/api/pricing",
    "/api/pricing/{modelId}",
    "/api/pricing/sync",
    "/api/usage/summary",
    "/api/usage/trends",
    "/api/usage/by-provider",
    "/api/usage/by-model",
    "/api/usage/logs",
    "/api/usage/logs/{id}",
    "/api/events",
    "/openapi.json",
    "/v1/chat/completions",
    "/v1/models",
  ]

  it("serves a valid OpenAPI 3.1 document covering every endpoint", async () => {
    const response = await api("/openapi.json")
    expect(response.status).toBe(200)
    const document = await body<Record<string, unknown>>(response)

    expect(document.openapi).toBe("3.1.0")
    expect(document.servers).toEqual([{ url: handle.url }])
    const info = document.info as { title: string; version: string }
    expect(info.title).toContain("model-infra-kit")
    expect(info.version).toBe("0.1.0")

    const paths = document.paths as Record<string, Record<string, unknown>>
    expect(Object.keys(paths).sort()).toEqual([...CONTRACT_PATHS].sort())

    const methods = ["get", "post", "put", "patch", "delete"]
    for (const [path, operations] of Object.entries(paths)) {
      expect(path.startsWith("/"), path).toBe(true)
      const declared = Object.keys(operations)
      expect(declared.length, path).toBeGreaterThan(0)
      for (const method of declared) {
        expect(methods, `${method} ${path}`).toContain(method)
        const operation = operations[method] as Record<string, unknown>
        expect(operation.responses, `${method} ${path}`).toBeTruthy()
        expect(Object.keys(operation.responses as object).length, `${method} ${path}`).toBeGreaterThan(0)
        for (const parameter of (operation.parameters ?? []) as Array<Record<string, unknown>>) {
          expect(["path", "query", "header", "cookie"], `${method} ${path}`).toContain(parameter.in)
          expect(parameter.schema, `${method} ${path}`).toBeTruthy()
        }
      }
    }

    // Every local reference must resolve inside `components`.
    const schemas = (document.components as { schemas: Record<string, unknown> }).schemas
    const unresolved = collectRefs(document).filter((item) => {
      const name = item.ref.replace("#/components/schemas/", "")
      return !item.ref.startsWith("#/components/schemas/") || schemas[name] === undefined
    })
    expect(unresolved).toEqual([])

    expect(document.security).toEqual([{ bearerAuth: [] }])
    expect((paths["/api/health"] as { get: { security: unknown[] } }).get.security).toEqual([])
    expect((document.components as { securitySchemes: Record<string, unknown> }).securitySchemes).toHaveProperty("bearerAuth")
  })

  it("omits the security requirement when no token is configured", async () => {
    const open = await createServer({ hub, port: 0, heartbeatMs: 0 })
    const document = await body<Record<string, unknown>>(await fetch(`${open.url}/openapi.json`))
    expect(document.security).toBeUndefined()
    await open.close()
  })
})

/** F07 — OpenAI `system`/`developer` messages and `tools` on the proxy endpoint. */
describe("F07 — system messages and tools", () => {
  interface UpstreamMessage {
    role: string
    content?: unknown
    tool_calls?: unknown[]
    tool_call_id?: string
  }

  interface ToolStreamChunk {
    choices: Array<{
      delta: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
      finish_reason: string | null
    }>
  }

  it("accepts a system message and hands it to the hub as `system`, not as a message", async () => {
    const generate = vi.spyOn(hub, "generate")
    const response = await chat({
      model: "ok:deepseek-chat",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hi" },
      ],
    })

    expect(response.status).toBe(200)
    expect((await body<OpenAiCompletion>(response)).choices[0]!.message.content).toBe("hello from the hub")

    // The AI SDK rejects a system message inside `messages`, so the hub must
    // receive it through `ModelRequest.system` and nowhere else.
    const request = generate.mock.calls[0]![0]
    expect(request.system).toBe("You are terse.")
    expect(request.messages).toEqual([{ role: "user", content: "hi" }])

    // …and the model really sees it: the provider serialises it as the first
    // upstream message.
    const upstream = await upstreamBody()
    const sent = upstream.messages as UpstreamMessage[]
    expect(sent).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ])
    expect(sent.some((message) => message.role === "developer")).toBe(false)
  })

  it("merges every system and developer message into one system field", async () => {
    const generate = vi.spyOn(hub, "generate")
    const response = await chat({
      model: "ok:deepseek-chat",
      messages: [
        { role: "system", content: "first" },
        { role: "developer", content: "second" },
        { role: "system", content: "third" },
        { role: "user", content: "hi" },
      ],
    })

    expect(response.status).toBe(200)
    expect(generate.mock.calls[0]![0].system).toBe("first\n\nsecond\n\nthird")
    expect(generate.mock.calls[0]![0].messages).toEqual([{ role: "user", content: "hi" }])

    const sent = (await upstreamBody()).messages as UpstreamMessage[]
    expect(sent).toEqual([
      { role: "system", content: "first\n\nsecond\n\nthird" },
      { role: "user", content: "hi" },
    ])
  })

  it("forwards tools to the model and returns tool_calls with finish_reason tool_calls", async () => {
    mock.urls[`${root}/ok/chat/completions`]!.response = { type: "json-value", body: TOOL_COMPLETION }
    const generate = vi.spyOn(hub, "generate")

    const response = await chat({
      model: "ok:deepseek-chat",
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [WEATHER_TOOL],
    })

    expect(response.status).toBe(200)
    const completion = await body<OpenAiCompletion>(response)
    const choice = completion.choices[0]!
    expect(choice.finish_reason).toBe("tool_calls")
    expect(choice.message.content).toBeNull()
    expect(choice.message.tool_calls).toEqual([
      {
        id: "call_weather_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ])

    // The hub got an AI SDK ToolSet with a JSON schema and no `execute`: the
    // proxy hands the call back to the client instead of running it.
    const tools = generate.mock.calls[0]![0].tools
    expect(Object.keys(tools ?? {})).toEqual(["get_weather"])
    expect(tools!.get_weather).toMatchObject({ description: "Look up the weather for a city." })
    expect(tools!.get_weather).not.toHaveProperty("execute")

    // The model really saw the tool definition.
    const upstreamTools = (await upstreamBody()).tools as Array<{
      type: string
      function: { name: string; description: string; parameters: unknown }
    }>
    expect(upstreamTools).toHaveLength(1)
    expect(upstreamTools[0]).toMatchObject({
      type: "function",
      function: {
        name: "get_weather",
        description: "Look up the weather for a city.",
        parameters: WEATHER_TOOL.function.parameters,
      },
    })
  })

  it("round-trips an assistant tool_calls turn and its tool result", async () => {
    const generate = vi.spyOn(hub, "generate")
    const response = await chat({
      model: "ok:deepseek-chat",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_weather_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_weather_1", content: '{"tempC":21}' },
      ],
      tools: [WEATHER_TOOL],
    })

    expect(response.status).toBe(200)
    expect((await body<OpenAiCompletion>(response)).choices[0]!.message.content).toBe("hello from the hub")

    // The hub received AI SDK shaped parts…
    const request = generate.mock.calls[0]![0]
    expect(request.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_weather_1",
          toolName: "get_weather",
          input: { city: "Paris" },
        },
      ],
    })
    expect(request.messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_weather_1",
          toolName: "get_weather",
          output: { type: "text", value: '{"tempC":21}' },
        },
      ],
    })

    // …and the provider put them back on the wire in OpenAI's shape.
    const sent = (await upstreamBody()).messages as UpstreamMessage[]
    expect(sent).toHaveLength(3)
    expect(sent[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_weather_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    })
    expect(sent[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_weather_1",
      content: '{"tempC":21}',
    })
  })

  it("streams with a system message and tools", async () => {
    mock.urls[`${root}/str/chat/completions`]!.response = {
      type: "stream-chunks",
      headers: { "content-type": "text/event-stream" },
      chunks: sse(
        JSON.stringify({
          id: "1",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { index: 0, id: "call_weather_1", type: "function", function: { name: "get_weather", arguments: "" } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        JSON.stringify({
          id: "1",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }, finish_reason: null },
          ],
        }),
        JSON.stringify({
          id: "1",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
        "[DONE]",
      ),
    }
    const stream = vi.spyOn(hub, "stream")

    const response = await chat({
      model: "str:deepseek-chat",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "weather in Paris?" },
      ],
      tools: [WEATHER_TOOL],
      stream: true,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    const request = stream.mock.calls[0]![0]
    expect(request.system).toBe("You are terse.")
    expect(request.messages).toEqual([{ role: "user", content: "weather in Paris?" }])
    expect(Object.keys(request.tools ?? {})).toEqual(["get_weather"])

    const frames = sseFrames(await response.text())
    expect(frames.at(-1)).toBe("[DONE]")
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame) as ToolStreamChunk)
    const argumentsText = chunks
      .flatMap((chunk) => chunk.choices[0]!.delta.tool_calls ?? [])
      .map((call) => call.function?.arguments ?? "")
      .join("")
    expect(argumentsText).toBe('{"city":"Paris"}')
    expect(chunks.flatMap((chunk) => chunk.choices[0]!.delta.tool_calls ?? []).some((call) => call.function?.name === "get_weather")).toBe(true)
    expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe("tool_calls")
  })

  it("still rejects an unusable role or a tool message without tool_call_id", async () => {
    const badRole = await chat({ model: "ok:deepseek-chat", messages: [{ role: "wizard", content: "hi" }] })
    expect(badRole.status).toBe(400)
    expect((await body<ErrorBody>(badRole)).error.code).toBe("INVALID_REQUEST")

    const orphanTool = await chat({ model: "ok:deepseek-chat", messages: [{ role: "tool", content: "result" }] })
    expect(orphanTool.status).toBe(400)
    expect((await body<ErrorBody>(orphanTool)).error.message).toContain("tool_call_id")

    const badTools = await chat({ model: "ok:deepseek-chat", messages: messages(), tools: [{ type: "function", function: {} }] })
    expect(badTools.status).toBe(400)
    expect((await body<ErrorBody>(badTools)).error.message).toContain("name")

    expect(hub.usage.query().total).toBe(0)
  })
})
