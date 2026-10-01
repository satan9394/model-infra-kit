import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { jsonSchema, tool } from "ai"
import { createTestServer } from "@ai-sdk/test-server"
import type { UrlResponse } from "@ai-sdk/test-server"
import type { PricingCatalog } from "llm-pricing"
import { ModelInfra } from "../src/index.js"
import type { ModelRequest, ProviderConfig } from "../src/index.js"

const ROOT = "https://mock-g100.test/v1"
const SESSION_ID = "g100-session-001"
const MODEL = "gpt-6-luna"

function completion(
  id: string,
  body: {
    content: string | null
    usage: Record<string, unknown>
    toolCall?: { id: string; name: string; input: Record<string, unknown> }
  },
) {
  const message = body.toolCall
    ? {
        role: "assistant",
        content: body.content,
        tool_calls: [
          {
            id: body.toolCall.id,
            type: "function",
            function: { name: body.toolCall.name, arguments: JSON.stringify(body.toolCall.input) },
          },
        ],
      }
    : { role: "assistant", content: body.content }
  return {
    id,
    object: "chat.completion",
    created: 1_790_000_000,
    model: MODEL,
    choices: [{ index: 0, message, finish_reason: body.toolCall ? "tool_calls" : "stop" }],
    usage: body.usage,
  }
}

const TOOL_USAGE = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }

/** @ai-sdk/test-server numbers calls globally, so each route pads its own slice. */
function responseSequence(start: number, responses: UrlResponse[]): UrlResponse[] {
  return [...Array.from({ length: start }, () => undefined), ...responses]
}

function gpt6TierFixture(): PricingCatalog {
  return {
    state: () => ({ status: "ready", loadedAt: 1, source: "modelsdev" }),
    ensureLoaded: async () => undefined,
    refresh: async () => undefined,
    getPrice: (model: string, _at?: number, facts?: { usedReasoning?: boolean }) =>
      model === MODEL
        ? {
            inputCostPerToken: 0.0000001,
            outputCostPerToken: facts?.usedReasoning ? 0.000001 : 0.0000005,
            cacheReadInputCostPerToken: 0.00000001,
            cacheCreationInputCostPerToken: 0.000000125,
            displayName: MODEL,
            source: "modelsdev",
            providerId: "reasoning",
          }
        : null,
  } as unknown as PricingCatalog
}

const mock = createTestServer({
  [`${ROOT}/planner/chat/completions`]: {
    response: responseSequence(0, [
      {
        type: "json-value",
        body: completion("g100-plan-tool", {
          content: null,
          usage: TOOL_USAGE,
          toolCall: { id: "g100-plan-call", name: "plan", input: { objective: "ship report" } },
        }),
      },
      {
        type: "json-value",
        body: completion("g100-plan-finish", {
          content: "plan ready",
          usage: { prompt_tokens: 18, completion_tokens: 5, total_tokens: 23 },
        }),
      },
    ]),
  },
  [`${ROOT}/tool-one/chat/completions`]: {
    response: responseSequence(2, [
      {
        type: "json-value",
        body: completion("g100-tool-one-call", {
          content: null,
          usage: TOOL_USAGE,
          toolCall: { id: "g100-tool-one", name: "fetch_source", input: { source: "primary" } },
        }),
      },
      {
        type: "json-value",
        body: completion("g100-tool-one-finish", {
          content: "source fetched",
          usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
        }),
      },
    ]),
  },
  [`${ROOT}/tool-two/chat/completions`]: {
    response: responseSequence(4, [
      {
        type: "json-value",
        body: completion("g100-tool-two-call", {
          content: null,
          usage: TOOL_USAGE,
          toolCall: { id: "g100-tool-two", name: "validate", input: { result: "source fetched" } },
        }),
      },
      {
        type: "json-value",
        body: completion("g100-tool-two-finish", {
          content: "result validated",
          usage: { prompt_tokens: 22, completion_tokens: 7, total_tokens: 29 },
        }),
      },
    ]),
  },
  [`${ROOT}/synthesis/chat/completions`]: {
    response: responseSequence(6, [
      {
        type: "json-value",
        body: completion("g100-synthesis-finish", {
          content: "report complete",
          usage: { prompt_tokens: 24, completion_tokens: 8, total_tokens: 32 },
        }),
      },
    ]),
  },
  [`${ROOT}/reasoning/chat/completions`]: {
    response: responseSequence(0, [
      {
        type: "json-value",
        body: completion("g100-reasoning", {
          content: "reasoned answer",
          usage: {
            prompt_tokens: 4_096,
            completion_tokens: 4_096,
            total_tokens: 8_192,
            prompt_tokens_details: { cached_tokens: 2_048 },
            completion_tokens_details: { reasoning_tokens: 2_048 },
          },
        }),
      },
    ]),
  },
  [`${ROOT}/primary/chat/completions`]: {
    response: responseSequence(0, [
      {
        type: "error",
        status: 429,
        body: JSON.stringify({ error: { message: "g100 primary rate limited", type: "rate_limit_error" } }),
      },
    ]),
  },
  [`${ROOT}/fallback/chat/completions`]: {
    response: responseSequence(1, [
      {
        type: "json-value",
        body: completion("g100-fallback", {
          content: "fallback answer",
          usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 },
        }),
      },
    ]),
  },
})

const offlineFetch = (async () => {
  throw new Error("network disabled in G100 tests")
}) as unknown as typeof globalThis.fetch

let hub: ModelInfra | undefined

function provider(id: string): ProviderConfig {
  return {
    id,
    protocol: "openai-compatible",
    baseUrl: `${ROOT}/${id}`,
  }
}

async function makeHub(providers: ProviderConfig[], options: { pricingCatalog?: PricingCatalog } = {}): Promise<ModelInfra> {
  hub = await ModelInfra.init({
    appId: "g100-test-app",
    db: ":memory:",
    cacheDir: join(tmpdir(), "mik-g100-pricing-cache"),
    pricingFetch: offlineFetch,
    pricingCatalog: options.pricingCatalog,
    pricingAutoSync: false,
    syncCatalog: false,
    maxRetries: 0,
    providers,
  })
  return hub
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { messages: [{ role: "user", content: "continue the workflow" }], ...overrides }
}

function actionTool(name: string, result: unknown, executed: string[]) {
  return {
    [name]: tool({
      description: `Run ${name} in the simulated agent workflow`,
      inputSchema: jsonSchema({
        type: "object",
        properties: { objective: { type: "string" }, source: { type: "string" }, result: { type: "string" } },
      }),
      execute: async (_input: unknown) => {
        executed.push(name)
        return result
      },
    }),
  }
}

beforeAll(() => mock.server.start())

beforeEach(() => mock.server.reset())

afterEach(async () => {
  await hub?.close()
  hub = undefined
})

afterAll(() => mock.server.stop())

describe("EVO-G100 multi-agent trace simulation", () => {
  it("runs a real four-trace tool workflow under one session and keeps micro-USD totals exact", async () => {
    const instance = await makeHub([provider("planner"), provider("tool-one"), provider("tool-two"), provider("synthesis")])
    instance.pricing.setOverride({ modelId: MODEL, inputPerM: 0.1, outputPerM: 0.5 })
    const executed: string[] = []

    const responses = [
      await instance.generate(
        request({
          model: `planner:${MODEL}`,
          sessionId: SESSION_ID,
          traceId: "g100-trace-plan",
          tools: actionTool("plan", { steps: ["fetch", "validate"] }, executed),
        }),
      ),
      await instance.generate(
        request({
          model: `tool-one:${MODEL}`,
          sessionId: SESSION_ID,
          traceId: "g100-trace-tool-one",
          tools: actionTool("fetch_source", { rows: 2 }, executed),
        }),
      ),
      await instance.generate(
        request({
          model: `tool-two:${MODEL}`,
          sessionId: SESSION_ID,
          traceId: "g100-trace-tool-two",
          tools: actionTool("validate", { valid: true }, executed),
        }),
      ),
      await instance.generate(
        request({ model: `synthesis:${MODEL}`, sessionId: SESSION_ID, traceId: "g100-trace-synthesis" }),
      ),
    ]

    expect(responses.map((response) => response.text)).toEqual([
      "plan ready",
      "source fetched",
      "result validated",
      "report complete",
    ])
    expect(responses.slice(0, 3).map((response) => response.toolCalls[0]?.name)).toEqual([
      "plan",
      "fetch_source",
      "validate",
    ])
    expect(responses.slice(0, 3).every((response) => response.steps === 2)).toBe(true)
    expect(executed).toEqual(["plan", "fetch_source", "validate"])

    const page = instance.usage.query({ sessionId: SESSION_ID })
    expect(page.total).toBe(4)
    expect(page.events.every((event) => event.status === "ok" && event.sessionId === SESSION_ID)).toBe(true)
    expect(new Set(page.events.map((event) => event.traceId))).toEqual(
      new Set(["g100-trace-plan", "g100-trace-tool-one", "g100-trace-tool-two", "g100-trace-synthesis"]),
    )

    const traceGroups = instance.usage.traces({ sessionId: SESSION_ID }, "trace")
    expect(traceGroups).toHaveLength(4)
    expect(traceGroups.every((group) => group.requests === 1 && group.successes === 1 && group.failures === 0)).toBe(true)

    const expectedMicros = page.events.reduce((sum, event) => sum + Math.round(event.cost.usd * 1_000_000), 0)
    expect(page.events.map((event) => Math.round(event.cost.usd * 1_000_000)).sort((a, b) => a - b)).toEqual([6, 8, 8, 9])
    expect(expectedMicros).toBe(31)
    const sessionGroup = instance.usage.traces({ sessionId: SESSION_ID }, "session")[0]
    expect(sessionGroup).toBeDefined()
    expect(Math.round((sessionGroup?.costLowUsd ?? 0) * 1_000_000)).toBe(expectedMicros)
    expect(Math.round((sessionGroup?.costHighUsd ?? 0) * 1_000_000)).toBe(expectedMicros)
  })

  it("maps cached prompt and reasoning tokens into the GPT-6 integer pricing tier", async () => {
    const instance = await makeHub([provider("reasoning")], { pricingCatalog: gpt6TierFixture() })

    const response = await instance.generate(
      request({ model: `reasoning:${MODEL}`, sessionId: "g100-reasoning-session", traceId: "g100-reasoning-trace" }),
    )

    expect(response.usage).toEqual({ input: 4_096, output: 4_096, cacheRead: 2_048, cacheWrite: 0, reasoning: 2_048 })
    expect(response.cost).toMatchObject({
      usd: 0.003297,
      low: 0.003297,
      high: 0.003297,
      basis: "exact",
      source: "modelsdev",
    })
    expect(instance.pricing.priceFor(MODEL, undefined, { usedReasoning: false })).toMatchObject({ outputPerM: 0.5 })
    expect(instance.pricing.priceFor(MODEL, undefined, { usedReasoning: true })).toMatchObject({ outputPerM: 1 })
    expect(instance.usage.query().events[0]).toMatchObject({
      sessionId: "g100-reasoning-session",
      traceId: "g100-reasoning-trace",
      usage: { input: 4_096, cacheRead: 2_048, reasoning: 2_048 },
      cost: { usd: 0.003297, low: 0.003297, high: 0.003297 },
    })
    expect(instance.usage.summary().tokens.reasoning).toBe(2_048)
  })

  it("records the 429 attempt and the successful fallback in one traced session", async () => {
    const instance = await makeHub([provider("primary"), provider("fallback")])

    const response = await instance.generate(
      request({
        model: `primary:${MODEL}`,
        fallbackChain: [`fallback:${MODEL}`],
        sessionId: "g100-fallback-session",
        traceId: "g100-fallback-trace",
      }),
    )

    expect(response.provider).toBe("fallback")
    expect(response.text).toBe("fallback answer")

    const events = instance.usage.query({ sessionId: "g100-fallback-session" }).events
    expect(events).toHaveLength(2)
    expect(events.find((event) => event.status === "error")).toMatchObject({
      providerId: "primary",
      status: "error",
      errorCode: "RATE_LIMIT",
      sessionId: "g100-fallback-session",
      traceId: "g100-fallback-trace",
    })
    expect(events.find((event) => event.status === "ok")).toMatchObject({
      providerId: "fallback",
      status: "ok",
      sessionId: "g100-fallback-session",
      traceId: "g100-fallback-trace",
      tags: { is_fallback: "true" },
    })
  })
})
