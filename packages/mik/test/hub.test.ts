import { createServer as createHttpServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { createTestServer } from "@ai-sdk/test-server"
import { jsonSchema, tool } from "ai"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelInfraError } from "../src/errors.js"
import { ModelInfra, type ModelInfraOptions } from "../src/hub.js"
// The package entry is exercised too: every name below must survive the barrel.
import * as mik from "../src/index.js"
import type {
  CostInfo,
  ModelInfo,
  ModelInfraConfig,
  ModelRequest,
  ModelResponse,
  ProviderConfig,
  StreamEvent,
  TokenUsage,
  UsageEvent,
} from "../src/index.js"

const TEST_KEY = "sk-t05-hub-testkey-1234"

/** The shape `docs/verified-facts.md` §1 recorded from a real run. */
const COMPLETION = {
  id: "chatcmpl-hub",
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

const TOOL_CALL_COMPLETION = {
  id: "chatcmpl-hub-tool",
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
          { id: "call_1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ city: "Shanghai" }) } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}

const FINAL_COMPLETION = {
  ...COMPLETION,
  id: "chatcmpl-hub-final",
  choices: [{ index: 0, message: { role: "assistant", content: "it is 24C" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
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

const STREAM_TOOL_CHUNKS = sse(
  JSON.stringify({
    id: "1",
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }],
        },
        finish_reason: null,
      },
    ],
  }),
  JSON.stringify({
    id: "1",
    model: "deepseek-chat",
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null },
    ],
  }),
  JSON.stringify({
    id: "1",
    model: "deepseek-chat",
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Shanghai"}' } }] }, finish_reason: null },
    ],
  }),
  JSON.stringify({
    id: "1",
    model: "deepseek-chat",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  }),
  "[DONE]",
)

/**
 * A stream that starts producing text and then fails mid-flight: the openai
 * compatible parser turns the `{"error": ...}` frame into an error part after
 * the deltas that came before it.
 */
const STREAM_ERROR_CHUNKS = sse(
  JSON.stringify({
    id: "1",
    model: "deepseek-chat",
    choices: [{ index: 0, delta: { role: "assistant", content: "partial " }, finish_reason: null }],
  }),
  JSON.stringify({ error: { message: "upstream stream exploded", type: "server_error", code: 500 } }),
  "[DONE]",
)

const MODELS = {
  object: "list",
  data: [
    { id: "deepseek-chat", object: "model", created: 1, owned_by: "mock" },
    { id: "deepseek-reasoner", object: "model", created: 2, owned_by: "mock" },
  ],
}

const root = "https://mock-hub.test/v1"

const server = createTestServer({
  [`${root}/ok/chat/completions`]: { response: { type: "json-value", body: COMPLETION } },
  // A tool loop: the first call asks for a tool, the second one answers.
  // (Routes are structured-cloned, so the array form is used instead of a callback.)
  [`${root}/tools/chat/completions`]: {
    response: [
      { type: "json-value", body: TOOL_CALL_COMPLETION },
      { type: "json-value", body: FINAL_COMPLETION },
    ],
  },
  [`${root}/stream/chat/completions`]: {
    response: {
      type: "stream-chunks",
      headers: { "content-type": "text/event-stream" },
      chunks: STREAM_CHUNKS,
    },
  },
  [`${root}/streamerror/chat/completions`]: {
    response: {
      type: "stream-chunks",
      headers: { "content-type": "text/event-stream" },
      chunks: STREAM_ERROR_CHUNKS,
    },
  },
  [`${root}/streamtool/chat/completions`]: {
    response: {
      type: "stream-chunks",
      headers: { "content-type": "text/event-stream" },
      chunks: STREAM_TOOL_CHUNKS,
    },
  },
  // Five tool-call answers in a row: the hub must stop the loop at `stepCountIs(5)`.
  [`${root}/loop/chat/completions`]: {
    response: Array.from({ length: 5 }, () => ({ type: "json-value" as const, body: TOOL_CALL_COMPLETION })),
  },
  [`${root}/fail/chat/completions`]: {
    response: {
      type: "error",
      status: 401,
      body: JSON.stringify({ error: { message: `invalid api key ${TEST_KEY}` } }),
    },
  },
  [`${root}/broken/chat/completions`]: { response: { type: "error", status: 500, body: "upstream exploded" } },
  [`${root}/ok/models`]: { response: { type: "json-value", body: MODELS } },
  [`${root}/broken/models`]: { response: { type: "error", status: 500, body: "no catalogue" } },
})

/** No test may reach the network: the catalogue load always fails here. */
const offlineFetch = (async () => {
  throw new Error("network disabled in tests")
}) as unknown as typeof globalThis.fetch

const hubs: ModelInfra[] = []
let cacheDir = ""
let warnings: string[] = []

beforeAll(() => {
  server.server.start()
  cacheDir = mkdtempSync(join(tmpdir(), "mik-t05-"))
  process.env.MIK_T05_HUB_KEY = TEST_KEY
})

afterAll(() => {
  server.server.stop()
  delete process.env.MIK_T05_HUB_KEY
})

beforeEach(() => {
  server.server.reset()
  warnings = []
})

afterEach(() => {
  while (hubs.length > 0) hubs.pop()?.close()
})

function provider(id: string): ProviderConfig {
  return { id, baseUrl: `${root}/${id}`, apiKeyRef: "env:MIK_T05_HUB_KEY", enabled: true }
}

async function makeHub(options: ModelInfraOptions = {}): Promise<ModelInfra> {
  const hub = await ModelInfra.init({
    appId: "t05-app",
    db: ":memory:",
    cacheDir,
    pricingFetch: offlineFetch,
    syncCatalog: false,
    // The SDK's own retry loop would add seconds to every failure case.
    maxRetries: 0,
    providers: ["ok", "tools", "stream", "streamerror", "streamtool", "loop", "fail", "broken"].map(provider),
    defaultModel: "ok:deepseek-chat",
    onWarn: (message) => warnings.push(message),
    ...options,
  })
  hubs.push(hub)
  return hub
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { messages: [{ role: "user", content: "hi" }], ...overrides }
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

/** The `ModelInfraError.code` a call fails with, or a marker for anything else. */
function codeOf(action: () => unknown): string {
  try {
    action()
    return "(no error)"
  } catch (error) {
    return error instanceof ModelInfraError ? error.code : `not-model-infra: ${String(error)}`
  }
}

describe("package entry", () => {
  it("exports the documented surface", () => {
    for (const name of [
      "ModelInfra",
      "ModelInfraError",
      "Store",
      "CredentialStore",
      "ProviderRegistry",
      "PricingService",
      "UsageService",
      "createAiBridge",
      "createMikFetch",
      "PROVIDER_PRESETS",
      "splitModelRef",
    ]) {
      expect(mik[name as keyof typeof mik], name).toBeDefined()
    }
    expect(typeof mik.ModelInfra.init).toBe("function")
    expect(mik.PROVIDER_PRESETS.length).toBeGreaterThan(0)
  })

  it("re-exports the public types", () => {
    // Compile-time only: these would fail `tsc --noEmit` if a type were missing.
    const config: ModelInfraConfig = { appId: "types", db: ":memory:" }
    const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    const cost: CostInfo = { usd: 0, low: 0, high: 0, basis: "flat", source: "missing" }
    const model: ModelInfo = {
      providerId: "p",
      modelId: "m",
      ref: "p:m",
      displayName: "m",
      capabilities: { text: true, image: false, toolCall: false, reasoning: false, structuredOutput: false },
      source: "preset",
    }
    const response = { usage, cost, model: { requested: "p:m", actual: "m" } } as unknown as ModelResponse
    const event = { cost } as unknown as UsageEvent
    const stream: StreamEvent = { type: "usage", usage, cost }
    expect([config.appId, model.ref, response.model.actual, event.cost.usd, stream.type]).toEqual([
      "types",
      "p:m",
      "m",
      0,
      "usage",
    ])
  })
})

describe("ModelInfra.init", () => {
  it("starts with no provider at all", async () => {
    const hub = await makeHub({ providers: [], defaultModel: undefined })
    expect(hub.appId).toBe("t05-app")
    expect(hub.providers.list()).toEqual([])
    expect(hub.models.list()).toEqual([])
    expect(hub.usage.summary().requests).toBe(0)
    expect(hub.baseUrl).toBe("http://127.0.0.1:0/v1")
    await expect(hub.catalogSync).resolves.toBeUndefined()
  })

  it("seeds providers and the default model", async () => {
    const hub = await makeHub()
    expect(hub.providers.list().map((record) => record.id)).toEqual([
      "broken",
      "fail",
      "loop",
      "ok",
      "stream",
      "streamerror",
      "streamtool",
      "tools",
    ])
    expect(hub.providers.defaultModel()).toBe("ok:deepseek-chat")
    // The preset-free config implies the openai-compatible protocol.
    expect(hub.providers.get("ok")?.protocol).toBe("openai-compatible")
  })

  it("lets the server inject the real base URL", async () => {
    const hub = await makeHub()
    hub.setBaseUrl("http://127.0.0.1:3211/v1/")
    expect(hub.baseUrl).toBe("http://127.0.0.1:3211/v1")
  })

  it("syncs the catalogue by default and only warns on failure", async () => {
    const hub = await makeHub({
      // Explicitly `undefined` proves the default is "on".
      syncCatalog: undefined,
      providers: [provider("ok"), provider("broken")],
      defaultModel: "ok:deepseek-chat",
    })
    await hub.catalogSync
    expect(hub.models.list("ok").map((model) => model.modelId)).toEqual(["deepseek-chat", "deepseek-reasoner"])
    expect(hub.models.list("broken")).toEqual([])
    expect(warnings.some((message) => message.includes("broken"))).toBe(true)
  })
})

describe("model resolution", () => {
  it("splits provider:model literally", async () => {
    const hub = await makeHub()
    expect(hub.resolveModel("stream:some-model")).toEqual({
      providerId: "stream",
      modelId: "some-model",
      requested: "stream:some-model",
    })
  })

  it("routes a bare model id through the default provider", async () => {
    const hub = await makeHub()
    expect(hub.resolveModel("deepseek-reasoner")).toEqual({
      providerId: "ok",
      modelId: "deepseek-reasoner",
      requested: "deepseek-reasoner",
    })
  })

  it("falls back to the configured default when no model is given", async () => {
    const hub = await makeHub()
    expect(hub.resolveModel()).toEqual({
      providerId: "ok",
      modelId: "deepseek-chat",
      requested: "ok:deepseek-chat",
    })
  })

  it("rejects a request with no model and no default", async () => {
    const hub = await makeHub({ defaultModel: undefined })
    expect(codeOf(() => hub.resolveModel())).toBe("INVALID_REQUEST")
  })

  it("rejects a bare model id when no default provider exists", async () => {
    const hub = await makeHub({ defaultModel: undefined })
    expect(codeOf(() => hub.resolveModel("deepseek-chat"))).toBe("INVALID_REQUEST")
  })

  it("rejects an unknown provider", async () => {
    const hub = await makeHub()
    expect(codeOf(() => hub.resolveModel("ghost:model"))).toBe("PROVIDER_NOT_FOUND")
  })

  it("rejects a malformed reference", async () => {
    const hub = await makeHub()
    expect(codeOf(() => hub.resolveModel("ok:"))).toBe("INVALID_REQUEST")
    expect(codeOf(() => hub.resolveModel(":model"))).toBe("INVALID_REQUEST")
  })
})

describe("generate", () => {
  it("returns a metered response and stores one usage row", async () => {
    const hub = await makeHub()
    const spy = vi.spyOn(hub.pricing, "estimate")
    const response = await hub.generate(request({ model: "ok:deepseek-chat", tags: { route: "test" } }))

    expect(response.text).toBe("hello from the hub")
    expect(response.finishReason).toBe("stop")
    expect(response.provider).toBe("ok")
    expect(response.model).toEqual({ requested: "ok:deepseek-chat", actual: "deepseek-chat" })
    expect(response.steps).toBe(1)
    expect(response.latencyMs).toBeGreaterThanOrEqual(0)
    expect(response.toolCalls).toEqual([])
    expect(response.usage).toEqual({ input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 })

    // The price is resolved for the model the provider actually served.
    expect(spy.mock.calls[0]![0].model).toBe("deepseek-chat")
    expect(spy.mock.calls[0]![0].at).toBeGreaterThan(0)
    // SPEC §4: an absent count reaches llm-pricing as undefined, never as 0.
    expect(spy.mock.calls[0]![0].usage.cacheWrite).toBeUndefined()
    expect(spy.mock.calls[0]![0].usage.cacheRead).toBe(800)
    expect(spy.mock.calls[0]![0].usage.reasoning).toBe(64)

    // The archive prices `deepseek-chat`, so the cost is not a placeholder.
    expect(response.cost.source).toBe("fallback")
    expect(response.cost.usd).toBeGreaterThan(0)

    const page = hub.usage.query()
    expect(page.total).toBe(1)
    const event = page.events[0]!
    expect(event).toMatchObject({
      appId: "t05-app",
      source: "generate",
      providerId: "ok",
      modelRequested: "ok:deepseek-chat",
      modelActual: "deepseek-chat",
      status: "ok",
      isStreaming: false,
      tags: { route: "test" },
    })
    expect(event.usage).toEqual({ input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 })
    expect(event.cost.usd).toBeCloseTo(response.cost.usd, 12)
  })

  it("runs a tool loop and sums the usage of every step", async () => {
    const hub = await makeHub()
    const calls: unknown[] = []
    const response = await hub.generate(
      request({
        model: "tools:deepseek-chat",
        tools: {
          lookup: tool({
            description: "Look up the weather",
            inputSchema: jsonSchema({
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            }),
            execute: async (input: unknown) => {
              calls.push(input)
              return { tempC: 24 }
            },
          }),
        },
      }),
    )

    expect(calls).toEqual([{ city: "Shanghai" }])
    expect(response.steps).toBe(2)
    expect(response.toolCalls).toEqual([{ id: "call_1", name: "lookup", input: { city: "Shanghai" } }])
    expect(response.text).toBe("it is 24C")
    // 10 + 20 input, 5 + 7 output.
    expect(response.usage.input).toBe(30)
    expect(response.usage.output).toBe(12)
    expect(server.calls.filter((call) => call.requestUrl.endsWith("/tools/chat/completions"))).toHaveLength(2)
  })

  it("stops a tool loop at the default step budget", async () => {
    const hub = await makeHub()
    const response = await hub.generate(
      request({
        model: "loop:deepseek-chat",
        tools: {
          lookup: tool({
            description: "Look up the weather",
            inputSchema: jsonSchema({ type: "object", properties: { city: { type: "string" } } }),
            execute: async () => ({ tempC: 24 }),
          }),
        },
      }),
    )

    expect(response.steps).toBe(5)
    expect(response.toolCalls).toHaveLength(5)
    expect(server.calls.filter((call) => call.requestUrl.endsWith("/loop/chat/completions"))).toHaveLength(5)
  })

  it("records a failed call and rethrows a safe error", async () => {
    const hub = await makeHub()
    let caught: unknown
    try {
      await hub.generate(request({ model: "fail:deepseek-chat" }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ModelInfraError)
    const mapped = caught as ModelInfraError
    expect(mapped.code).toBe("AUTH")
    expect(mapped.message).not.toContain(TEST_KEY)
    expect(mapped.message).toContain("API key rejected")

    const page = hub.usage.query()
    expect(page.total).toBe(1)
    expect(page.events[0]).toMatchObject({ status: "error", errorCode: "AUTH", source: "generate" })
    expect(page.events[0]!.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(page.events[0]!.cost.usd).toBe(0)
  })

  it("maps a provider 5xx onto a retryable PROVIDER error", async () => {
    const hub = await makeHub()
    await expect(hub.generate(request({ model: "broken:deepseek-chat" }))).rejects.toMatchObject({
      code: "PROVIDER",
      retryable: true,
    })
    expect(hub.usage.query().events[0]).toMatchObject({ status: "error", errorCode: "PROVIDER" })
  })

  it("hands every stored event to the observer", async () => {
    const seen: UsageEvent[] = []
    const hub = await makeHub({ onUsage: (event) => seen.push(event) })
    await hub.generate(request())
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ appId: "t05-app", source: "generate", modelActual: "deepseek-chat" })
    expect(seen[0]!.requestId).toBe(hub.usage.query().events[0]!.requestId)
  })

  it("survives a usage listener that throws", async () => {
    const hub = await makeHub({
      onUsage: () => {
        throw new Error("listener boom")
      },
    })
    const response = await hub.generate(request())
    expect(response.text).toBe("hello from the hub")
    expect(hub.usage.query().total).toBe(1)
    expect(warnings.some((message) => message.includes("listener"))).toBe(true)
  })

  it("keeps the credential out of every returned structure", async () => {
    const hub = await makeHub()
    const response = await hub.generate(request())
    const seen: UsageEvent[] = hub.usage.query().events
    const serialized = JSON.stringify({ response, seen, warnings, status: await hub.ai.test("ok") })
    expect(serialized).not.toContain(TEST_KEY)
    expect(serialized).not.toContain("Bearer ")
  })
})

describe("stream", () => {
  it("emits the documented events and records usage before finish", async () => {
    const hub = await makeHub()
    const events = await collect(hub.stream(request({ model: "stream:deepseek-chat" })))
    const types = events.map((event) => event.type)

    expect(types).toContain("text_delta")
    expect(types).toContain("step_finish")
    expect(types).toContain("usage")
    expect(types.at(-1)).toBe("finish")
    expect(types).not.toContain("error")

    const text = events
      .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.text)
      .join("")
    expect(text).toBe("hello world")

    const usageEvent = events.find((event): event is Extract<StreamEvent, { type: "usage" }> => event.type === "usage")!
    expect(usageEvent.usage).toEqual({ input: 40, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(usageEvent.cost.source).toBe("fallback")

    const finish = events.at(-1) as Extract<StreamEvent, { type: "finish" }>
    expect(finish.response.text).toBe("hello world")
    expect(finish.response.model).toEqual({ requested: "stream:deepseek-chat", actual: "deepseek-chat" })
    expect(finish.response.firstTokenMs).toBeGreaterThanOrEqual(0)
    expect(finish.response.steps).toBe(1)

    expect(hub.usage.query().events[0]).toMatchObject({
      source: "stream",
      isStreaming: true,
      status: "ok",
      modelActual: "deepseek-chat",
    })
  })

  it("emits tool call events while streaming", async () => {
    const hub = await makeHub()
    const events = await collect(hub.stream(request({ model: "streamtool:deepseek-chat" })))

    const deltas = events.filter(
      (event): event is Extract<StreamEvent, { type: "tool_call_delta" }> => event.type === "tool_call_delta",
    )
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas[0]!.name).toBe("lookup")

    const complete = events.find(
      (event): event is Extract<StreamEvent, { type: "tool_call_complete" }> => event.type === "tool_call_complete",
    )
    expect(complete).toBeDefined()
    expect(complete!.call).toEqual({ id: "call_1", name: "lookup", input: { city: "Shanghai" } })

    const finish = events.at(-1) as Extract<StreamEvent, { type: "finish" }>
    expect(finish.response.toolCalls).toEqual([{ id: "call_1", name: "lookup", input: { city: "Shanghai" } }])
    expect(finish.response.finishReason).toBe("tool-calls")
    expect(hub.usage.query().events[0]).toMatchObject({ status: "ok", isStreaming: true })
  })

  it("has the row stored by the time finish is emitted", async () => {
    const hub = await makeHub()
    let totalAtFinish = -1
    for await (const event of hub.stream(request({ model: "stream:deepseek-chat" }))) {
      if (event.type === "finish") totalAtFinish = hub.usage.query().total
    }
    expect(totalAtFinish).toBe(1)
  })

  it("reports a provider failure as an error event instead of throwing", async () => {
    const hub = await makeHub()
    const events = await collect(hub.stream(request({ model: "broken:deepseek-chat" })))
    const error = events.find((event): event is Extract<StreamEvent, { type: "error" }> => event.type === "error")
    expect(error).toBeDefined()
    expect(error!.error.code).toBe("PROVIDER")
    expect(error!.error.message).not.toContain(TEST_KEY)
    // Draining to the end must still leave exactly one row, not two.
    expect(hub.usage.query().total).toBe(1)
    expect(hub.usage.query().events[0]).toMatchObject({ status: "error", errorCode: "PROVIDER", isStreaming: true })
  })

  it("records a failed row when the consumer stops at a mid-stream error", async () => {
    const hub = await makeHub()
    const events: StreamEvent[] = []
    for await (const event of hub.stream(request({ model: "streamerror:deepseek-chat" }))) {
      events.push(event)
      if (event.type === "error") break
    }

    // The deltas before the failure still reached the consumer.
    expect(events.map((event) => event.type)).toEqual(["text_delta", "error"])
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "PROVIDER" } })

    // Breaking here closes the generator; the row must exist anyway.
    const page = hub.usage.query()
    expect(page.total).toBe(1)
    expect(page.events[0]).toMatchObject({
      source: "stream",
      isStreaming: true,
      status: "error",
      errorCode: "PROVIDER",
      modelActual: "deepseek-chat",
    })
  })

  it("records an ok row when the consumer stops at finish", async () => {
    const hub = await makeHub()
    let stops = 0
    for await (const event of hub.stream(request({ model: "stream:deepseek-chat" }))) {
      if (event.type === "finish") {
        stops += 1
        break
      }
    }

    expect(stops).toBe(1)
    const page = hub.usage.query()
    // Exactly one row: the success path and the abandon path must not both write.
    expect(page.total).toBe(1)
    expect(page.events[0]).toMatchObject({
      source: "stream",
      isStreaming: true,
      status: "ok",
      modelActual: "deepseek-chat",
    })
    expect(page.events[0]!.cost.source).toBe("fallback")
  })

  it("records a row when the consumer stops at the very first delta", async () => {
    const hub = await makeHub()
    for await (const event of hub.stream(request({ model: "stream:deepseek-chat" }))) {
      if (event.type === "text_delta") break
    }

    const page = hub.usage.query()
    // No error and no finish were ever seen, so the status is whatever was known.
    expect(page.total).toBe(1)
    expect(["ok", "error"]).toContain(page.events[0]!.status)
    expect(page.events[0]).toMatchObject({
      source: "stream",
      isStreaming: true,
      modelActual: "deepseek-chat",
    })
  })

  it("reports an unroutable model as an error event", async () => {
    const hub = await makeHub()
    const events = await collect(hub.stream(request({ model: "ghost:model" })))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "error", error: { code: "PROVIDER_NOT_FOUND" } })
  })
})

describe("models", () => {
  it("lists nothing until the catalogue is refreshed", async () => {
    const hub = await makeHub()
    expect(hub.models.list()).toEqual([])
    const models = await hub.models.refresh("ok")
    expect(models.map((model) => model.modelId)).toEqual(["deepseek-chat", "deepseek-reasoner"])
    expect(hub.models.list("ok")).toHaveLength(2)
    expect(hub.models.list("tools")).toEqual([])
  })

  it("gets one model by reference and attaches its price", async () => {
    const hub = await makeHub()
    await hub.models.refresh("ok")
    expect(hub.models.get("nope:model")).toBeNull()
    expect(hub.models.get("ok:not-there")).toBeNull()

    const found = hub.models.get("ok:deepseek-chat")!
    expect(found.ref).toBe("ok:deepseek-chat")
    expect(found.source).toBe("provider_api")
    expect(found.pricing?.source).toBe("fallback")
    expect(found.pricing?.inputPerM).toBeCloseTo(0.14, 12)
  })

  it("keeps the stored catalogue when a refresh fails", async () => {
    const hub = await makeHub()
    await hub.models.refresh("ok")
    await expect(hub.models.refresh("broken")).resolves.toEqual([])
    expect(hub.models.list("ok")).toHaveLength(2)
  })

  it("refuses to refresh an unconfigured provider", async () => {
    const hub = await makeHub()
    await expect(hub.models.refresh("ghost")).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" })
  })
})

describe("catalogue sync noise and close races (F08)", () => {
  /**
   * `makeHub` injects a failing pricing fetch, so llm-pricing always reports its
   * own `modelsdev` warning. Everything else must be absent.
   */
  function hostWarnings(): string[] {
    return warnings.filter((message) => !message.includes("modelsdev"))
  }

  /**
   * A `/v1/models` endpoint that answers only when the test opens its gate. It
   * runs on a real socket rather than the MSW test server because the latter
   * has no way to hold a response open.
   */
  async function gatedModelsServer(): Promise<{ baseUrl: string; release: () => void; stop: () => Promise<void> }> {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gateServer = createHttpServer((_request, response) => {
      void gate.then(() => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(MODELS))
      })
    })
    await new Promise<void>((resolve) => gateServer.listen(0, "127.0.0.1", resolve))
    const { port } = gateServer.address() as AddressInfo
    return {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      release: () => release(),
      stop: () => new Promise<void>((resolve) => gateServer.close(() => resolve())),
    }
  }

  it("skips a provider with no credential without warning", async () => {
    delete process.env.MIK_F08_ABSENT_KEY
    const hub = await makeHub({
      syncCatalog: true,
      providers: [{ id: "local", baseUrl: `${root}/local`, apiKeyRef: "env:MIK_F08_ABSENT_KEY", enabled: true }],
      defaultModel: undefined,
    })
    await hub.catalogSync
    expect(hub.models.list("local")).toEqual([])
    expect(hostWarnings()).toEqual([])
  })

  it("skips a disabled provider without warning", async () => {
    const hub = await makeHub({
      syncCatalog: true,
      providers: [{ ...provider("ok"), enabled: false }],
      defaultModel: undefined,
    })
    await hub.catalogSync
    expect(hub.models.list("ok")).toEqual([])
    expect(hostWarnings()).toEqual([])
  })

  it("still warns when the provider endpoint really fails", async () => {
    const hub = await makeHub({ syncCatalog: true, providers: [provider("broken")], defaultModel: undefined })
    await hub.catalogSync
    expect(hostWarnings().some((message) => message.includes("broken"))).toBe(true)
  })

  it("waits for an in-flight catalogue sync before closing the store", async () => {
    const slow = await gatedModelsServer()
    // The gate lives on its own socket, so MSW reports the pass-through request.
    const msw = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const hub = await makeHub({
        syncCatalog: true,
        providers: [{ id: "slow", baseUrl: slow.baseUrl, apiKeyRef: "env:MIK_T05_HUB_KEY", enabled: true }],
        defaultModel: undefined,
      })
      // close() is asked to shut down while the model list is still unanswered;
      // the store must survive until the sync has written to it, otherwise the
      // write fails with `database is not open`.
      const closed = hub.close()
      slow.release()
      await closed
      expect(hostWarnings()).toEqual([])
    } finally {
      msw.mockRestore()
      await slow.stop()
    }
  })

  it("closes cleanly with a provider across repeated init/close rounds", async () => {
    for (let round = 0; round < 3; round += 1) {
      const hub = await makeHub({ syncCatalog: true, providers: [provider("ok")], defaultModel: "ok:deepseek-chat" })
      await hub.close()
    }
    expect(hostWarnings()).toEqual([])
  })

  it("treats a second close() as a no-op", async () => {
    const hub = await makeHub()
    await hub.close()
    await expect(hub.close()).resolves.toBeUndefined()
    expect(hostWarnings()).toEqual([])
  })
})

describe("startup bounds and the closed-instance contract (F10)", () => {
  /** A transport that never answers: the shape of a black-holed TCP connection. */
  const hangingFetch = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch

  /** A transport that only fails after `delayMs`, i.e. one that drops slowly. */
  function slowFailingFetch(delayMs: number): typeof globalThis.fetch {
    return (() =>
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(new Error("catalogue upstream did not answer")), delayMs)
      })) as unknown as typeof globalThis.fetch
  }

  function timeoutWarnings(): string[] {
    return warnings.filter((message) => message.includes("did not load within"))
  }

  it("returns from init() within the bounded wait when the price catalogue never settles", async () => {
    const startedAt = Date.now()
    const hub = await makeHub({ pricingFetch: hangingFetch })
    const elapsedMs = Date.now() - startedAt
    const state = hub.pricing.state()

    // Printed so the evidence report carries the real number.
    console.log(`[F10] hanging catalogue: init() returned in ${elapsedMs} ms; pricing.state()=${JSON.stringify(state)}`)
    expect(elapsedMs).toBeLessThan(6_000)
    expect(state.status).not.toBe("fresh")
    // Rule 6: degrade and warn once, never hang and never throw.
    expect(timeoutWarnings()).toHaveLength(1)
  }, 20_000)

  it("returns from init() within the bounded wait when the catalogue fails slowly", async () => {
    const startedAt = Date.now()
    const hub = await makeHub({ pricingFetch: slowFailingFetch(5_000) })
    const elapsedMs = Date.now() - startedAt

    console.log(`[F10] slow-failing catalogue: init() returned in ${elapsedMs} ms`)
    expect(elapsedMs).toBeLessThan(6_000)
    expect(hub.pricing.state().status).not.toBe("fresh")
  }, 20_000)

  it("still loads the model catalogue on the normal path", async () => {
    const hub = await makeHub({ syncCatalog: true, providers: [provider("ok")], defaultModel: "ok:deepseek-chat" })
    await hub.catalogSync
    expect(hub.models.list("ok").map((model) => model.modelId)).toEqual(["deepseek-chat", "deepseek-reasoner"])
    // The injected transport fails immediately, so the bounded wait settles and
    // must not be reported as a timeout.
    expect(timeoutWarnings()).toEqual([])
  })

  it("refuses every public member with a ModelInfraError after close()", async () => {
    const hub = await makeHub()
    await hub.close()

    // `generate` is async, so its refusal arrives as a rejection.
    let caught: unknown
    try {
      await hub.generate(request())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ModelInfraError)
    const failure = caught as ModelInfraError
    expect(failure.code).toBe("STORAGE")
    expect(failure.message).toContain("this ModelInfra instance has been closed")

    // The failure the guard replaces (S1): the closed store underneath throws a
    // raw `node:sqlite` error, which is not a `ModelInfraError` at all.
    const bare = await mik.Store.open({ path: ":memory:" })
    bare.close()
    let raw: unknown
    try {
      bare.models.list()
    } catch (error) {
      raw = error
    }
    const rawCode = (raw as { code?: string }).code
    // Printed so the evidence report carries the real types and codes.
    console.log(
      `[F10] after close(): generate → ${failure.name} code=${failure.code}; raw closed store → ${(raw as Error).name} code=${String(rawCode)}`,
    )
    expect(raw).not.toBeInstanceOf(ModelInfraError)

    // Every other member refuses synchronously. `codeOf` reports the raw
    // sqlite/`ERR_INVALID_STATE` case as `not-model-infra: ...`, so a STORAGE
    // code here is also the `instanceof` assertion for each one.
    const members: [string, () => unknown][] = [
      ["stream", () => hub.stream(request())],
      ["resolveModel", () => hub.resolveModel("ok:deepseek-chat")],
      ["setBaseUrl", () => hub.setBaseUrl("http://127.0.0.1:3211/v1")],
      ["fetch", () => hub.fetch(`${hub.baseUrl}/chat/completions`, { method: "POST" })],
      ["models.list", () => hub.models.list()],
      ["models.get", () => hub.models.get("ok:deepseek-chat")],
      ["models.refresh", () => hub.models.refresh("ok")],
      ["providers.list", () => hub.providers.list()],
      ["usage.summary", () => hub.usage.summary()],
      ["pricing.estimate", () => hub.pricing.estimate({ model: "deepseek-chat", usage: {} })],
    ]
    for (const [label, call] of members) {
      expect(codeOf(call), label).toBe("STORAGE")
    }
  })
})
