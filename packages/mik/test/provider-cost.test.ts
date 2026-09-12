/**
 * EVO-G73 — provider-reported cost (`PriceSource = "provider"`).
 *
 * The **shape and the layer** these tests drive are measured, not quoted:
 * `.tmp/probe-g73.mjs` shows an OpenAI-compatible `usage.cost` surviving in the
 * AI SDK's `usage.raw` (on `steps[i].usage.raw` for `generateText`, on the
 * `finish-step` part for `streamText`) while `providerMetadata` comes back
 * empty — see `src/pricing/reported-cost.ts`.
 *
 * Every test injects `MIK_LANG`; none reads the host locale.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { createTestServer } from "@ai-sdk/test-server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { main } from "../src/cli/index.js"
import { USAGE_CSV_COLUMNS, usageCsv } from "../src/cli/csv.js"
import type { ModelInfraOptions } from "../src/hub.js"
import { ModelInfra } from "../src/hub.js"
import {
  PROVIDER_COST_RAW_TAG,
  PROVIDER_COST_STATUS_TAG,
  combineReportedCosts,
  providerCostInfo,
  providerCostTags,
  readReportedCostUsd,
  reportedCostFromProviderMetadata,
  reportedCostFromUsage,
} from "../src/pricing/reported-cost.js"
// Rule 5 / G11: the public signatures (`ForwardedCall.providerCost`,
// `readOpenAiUsage().cost`) are written in this type, so a host must be able to
// import it by name from the package barrel — not only from the internal module.
import type { CostInfo, ModelRequest, ProviderConfig, ProviderCostReading, UsageEvent } from "../src/index.js"

const TEST_KEY = "sk-g73-provider-cost-key"
const APP_ID = "g73-app"
const PRICING_MODEL = "deepseek-chat"
const ROOT = "https://mock-g73.test/v1"

/** 1200 in / 300 out / 800 cache-read / 64 reasoning, like the hub fixtures. */
const USAGE_COST = {
  prompt_tokens: 1200,
  completion_tokens: 300,
  total_tokens: 1500,
  prompt_tokens_details: { cached_tokens: 800 },
  completion_tokens_details: { reasoning_tokens: 64 },
}

function completion(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl-g73",
    object: "chat.completion",
    created: 1_700_000_000,
    model: PRICING_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "hello from g73" }, finish_reason: "stop" }],
    usage,
  }
}

/** One SSE frame per line, the final one carrying `usage` (and whatever cost). */
function sseWithCost(cost: unknown, withCost = true): string[] {
  const usage = withCost ? { ...USAGE_COST, cost } : { ...USAGE_COST }
  return [
    JSON.stringify({
      id: "1",
      object: "chat.completion.chunk",
      created: 1,
      model: PRICING_MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: "hello " }, finish_reason: null }],
    }),
    JSON.stringify({
      id: "1",
      object: "chat.completion.chunk",
      created: 1,
      model: PRICING_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    }),
    "[DONE]",
  ].map((frame) => `data: ${frame}\n\n`)
}

/** A streaming route. A `json-value` route cannot answer a `stream: true` body. */
function sseRoute(cost: unknown, withCost = true): {
  response: { type: "stream-chunks"; headers: Record<string, string>; chunks: string[] }
} {
  return {
    response: { type: "stream-chunks", headers: { "content-type": "text/event-stream" }, chunks: sseWithCost(cost, withCost) },
  }
}

/**
 * Per-scenario routes. `ok` is the only non-streaming one whose endpoint reports
 * an amount; `nocost` is byte-for-byte the pre-G73 shape. The `stream-*` family
 * mirrors them over SSE, because the SDK sends `stream: true` there.
 */
const server = createTestServer({
  [`${ROOT}/ok/chat/completions`]: { response: { type: "json-value", body: completion({ ...USAGE_COST, cost: "0.000123" }) } },
  [`${ROOT}/number/chat/completions`]: { response: { type: "json-value", body: completion({ ...USAGE_COST, cost: 0.000123 }) } },
  [`${ROOT}/nocost/chat/completions`]: { response: { type: "json-value", body: completion(USAGE_COST) } },
  [`${ROOT}/null/chat/completions`]: { response: { type: "json-value", body: completion({ ...USAGE_COST, cost: null }) } },
  [`${ROOT}/text/chat/completions`]: { response: { type: "json-value", body: completion({ ...USAGE_COST, cost: "abc" }) } },
  [`${ROOT}/negative/chat/completions`]: { response: { type: "json-value", body: completion({ ...USAGE_COST, cost: -1 }) } },
  [`${ROOT}/huge/chat/completions`]: { response: { type: "json-value", body: completion({ ...USAGE_COST, cost: 1e300 }) } },
  [`${ROOT}/stream/chat/completions`]: sseRoute("0.000123"),
  [`${ROOT}/stream-nocost/chat/completions`]: sseRoute(undefined, false),
  [`${ROOT}/stream-text/chat/completions`]: sseRoute("abc"),
  [`${ROOT}/stream-negative/chat/completions`]: sseRoute(-1),
  [`${ROOT}/stream-huge/chat/completions`]: sseRoute(1e300),
})

const PROVIDERS = [
  "ok",
  "number",
  "nocost",
  "null",
  "text",
  "negative",
  "huge",
  "stream",
  "stream-nocost",
  "stream-text",
  "stream-negative",
  "stream-huge",
]

/** No test may reach the network. */
const offlineFetch = (async () => {
  throw new Error("network disabled in tests")
}) as unknown as typeof globalThis.fetch

const hubs: ModelInfra[] = []
let cacheDir = ""
let warnings: string[] = []
const tempDirs: string[] = []

beforeAll(() => {
  server.server.start()
  cacheDir = mkdtempSync(join(tmpdir(), "mik-g73-"))
  process.env.MIK_G73_KEY = TEST_KEY
})

afterAll(() => {
  server.server.stop()
  delete process.env.MIK_G73_KEY
})

beforeEach(() => {
  server.server.reset()
  warnings = []
})

afterEach(() => {
  while (hubs.length > 0) void hubs.pop()?.close()
})

function provider(id: string): ProviderConfig {
  return { id, baseUrl: `${ROOT}/${id}`, apiKeyRef: "env:MIK_G73_KEY", enabled: true }
}

/**
 * A hub whose price catalogue is the **unchanged control entry point**: a manual
 * override gives every model a deterministic, non-zero card price, so a test can
 * tell "the provider's amount was adopted" from "the pre-G73 estimate ran" by
 * comparing against `pricing.estimate()` rather than a hand-computed float.
 */
async function makeHub(options: ModelInfraOptions = {}): Promise<ModelInfra> {
  const hub = await ModelInfra.init({
    appId: APP_ID,
    db: ":memory:",
    cacheDir,
    pricingFetch: offlineFetch,
    syncCatalog: false,
    maxRetries: 0,
    providers: PROVIDERS.map(provider),
    defaultModel: "ok:deepseek-chat",
    onWarn: (message) => warnings.push(message),
    ...options,
  })
  hub.pricing.setOverride({ modelId: PRICING_MODEL, inputPerM: 2, outputPerM: 4 })
  hubs.push(hub)
  return hub
}

function request(model: string, tags?: Record<string, string>): ModelRequest {
  return { model, messages: [{ role: "user", content: "hi" }], ...(tags === undefined ? {} : { tags }) }
}

/** The estimate the *unchanged* pricing path produces for this exact usage. */
function controlCost(hub: ModelInfra): CostInfo {
  return hub.pricing.estimate({ model: PRICING_MODEL, usage: { input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 } })
}

function onlyEvent(hub: ModelInfra, requestId?: string): UsageEvent {
  const page = hub.usage.query({ appId: APP_ID, limit: 50 })
  const event = requestId === undefined ? page.events[0] : page.events.find((item) => item.requestId === requestId)
  expect(event, "expected exactly one recorded usage event").toBeDefined()
  return event!
}

describe("reported-cost — unit normalisation (pure)", () => {
  it("reads dollars, not ticks: the same amount in two shapes gives one micro-USD value", () => {
    const fromString = readReportedCostUsd("0.000123")
    const fromNumber = readReportedCostUsd(0.000123)
    expect(fromString).toEqual({ kind: "accepted", micros: 123, raw: "0.000123" })
    expect(fromNumber).toEqual({ kind: "accepted", micros: 123, raw: "0.000123" })
    // An integer is dollars too (1 -> $1 -> 1_000_000 µ$), never "ticks".
    expect(readReportedCostUsd(1)).toEqual({ kind: "accepted", micros: 1_000_000, raw: "1" })
    expect(readReportedCostUsd("1.5")).toEqual({ kind: "accepted", micros: 1_500_000, raw: "1.5" })
  })

  it("keeps an explicit zero (the provider said 'free') but refuses a non-zero that rounds to 0", () => {
    expect(readReportedCostUsd(0)).toEqual({ kind: "accepted", micros: 0, raw: "0" })
    expect(readReportedCostUsd("0")).toEqual({ kind: "accepted", micros: 0, raw: "0" })
    expect(readReportedCostUsd(1e-12)).toMatchObject({ kind: "rejected", reason: "rounds down to zero micro-USD" })
  })

  it("treats a missing or null field as 'did not report', not as zero", () => {
    expect(readReportedCostUsd(undefined)).toEqual({ kind: "absent" })
    expect(readReportedCostUsd(null)).toEqual({ kind: "absent" })
    expect(reportedCostFromUsage({ prompt_tokens: 1 })).toEqual({ kind: "absent" })
    expect(reportedCostFromUsage(undefined)).toEqual({ kind: "absent" })
  })

  it("reads the OpenRouter-style provider metadata namespace as the second carrier", () => {
    expect(reportedCostFromProviderMetadata({ openrouter: { usage: { cost: 0.000123 } } })).toEqual({
      kind: "accepted",
      micros: 123,
      raw: "0.000123",
    })
    expect(reportedCostFromProviderMetadata({ somegateway: { total_cost: "0.5" } })).toEqual({
      kind: "accepted",
      micros: 500_000,
      raw: "0.5",
    })
    expect(reportedCostFromProviderMetadata({ mock: {} })).toEqual({ kind: "absent" })
    // The gateway's own upstream cost is NOT the caller's bill: never read it.
    expect(reportedCostFromProviderMetadata({ openrouter: { usage: { cost_details: { upstream_inference_cost: 0.0001 } } } })).toEqual({
      kind: "absent",
    })
  })

  it("adopts atomically: a partially reported multi-step row falls back as a whole", () => {
    const accepted = readReportedCostUsd("0.000123")
    expect(combineReportedCosts([accepted, readReportedCostUsd("0.0002")])).toEqual({
      kind: "accepted",
      micros: 323,
      raw: '["0.000123","0.0002"]',
    })
    expect(combineReportedCosts([accepted, { kind: "absent" }])).toMatchObject({ kind: "rejected" })
    expect(combineReportedCosts([accepted, readReportedCostUsd(-1)])).toMatchObject({ kind: "rejected", reason: "negative amount" })
    expect(combineReportedCosts([{ kind: "absent" }])).toEqual({ kind: "absent" })
    expect(combineReportedCosts([])).toEqual({ kind: "absent" })
  })

  it("describes the adopted cost and the tags without inventing an estimate band", () => {
    expect(providerCostInfo({ micros: 123, pricingModel: PRICING_MODEL })).toEqual({
      usd: 0.000123,
      low: 0.000123,
      high: 0.000123,
      basis: "exact",
      source: "provider",
      pricingModel: PRICING_MODEL,
    })
    expect(providerCostTags({ kind: "absent" })).toEqual({})
    expect(providerCostTags({ kind: "accepted", micros: 123, raw: "0.000123" })).toEqual({
      [PROVIDER_COST_RAW_TAG]: "0.000123",
      [PROVIDER_COST_STATUS_TAG]: "accepted",
    })
    expect(providerCostTags({ kind: "rejected", raw: "abc", reason: "not a decimal amount" })).toEqual({
      [PROVIDER_COST_RAW_TAG]: "abc",
      [PROVIDER_COST_STATUS_TAG]: "rejected: not a decimal amount",
    })
  })
})

describe("A1 — a reported amount is adopted, in micro-USD, with the raw value kept", () => {
  it("bills generate() at the reported amount and labels it provider", async () => {
    const hub = await makeHub()
    const control = controlCost(hub)
    const response = await hub.generate(request("ok:deepseek-chat", { route: "test" }))

    expect(response.cost.source).toBe("provider")
    expect(response.cost.usd).toBe(0.000123)
    expect(Math.round(response.cost.usd * 1_000_000)).toBe(123)
    // The reported amount deliberately disagrees with the card: the bill wins.
    expect(response.cost.usd).not.toBe(control.usd)
    expect(response.cost.low).toBe(response.cost.usd)
    expect(response.cost.high).toBe(response.cost.usd)
    expect(response.cost.pricingModel).toBe(PRICING_MODEL)

    const event = onlyEvent(hub)
    expect(event.cost.source).toBe("provider")
    expect(Math.round(event.cost.usd * 1_000_000)).toBe(123)
    // The raw value survives verbatim, next to the host's own tag.
    expect(event.tags?.[PROVIDER_COST_RAW_TAG]).toBe("0.000123")
    expect(event.tags?.[PROVIDER_COST_STATUS_TAG]).toBe("accepted")
    expect(event.tags?.route).toBe("test")
  })

  it("reads the amount from the OpenAI-compatible envelope on the mik.fetch path too", async () => {
    const hub = await makeHub()
    hub.setBaseUrl("http://127.0.0.1:1/v1")
    const response = await hub.fetch("http://127.0.0.1:1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "ok:deepseek-chat", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(response.status).toBe(200)
    await response.json()

    const event = onlyEvent(hub)
    expect(event.cost.source).toBe("provider")
    expect(Math.round(event.cost.usd * 1_000_000)).toBe(123)
    expect(event.tags?.[PROVIDER_COST_RAW_TAG]).toBe("0.000123")
  })

  it("reads a reported amount out of a streamed finish-step", async () => {
    const hub = await makeHub()
    const events = []
    for await (const event of hub.stream(request("stream:deepseek-chat"))) events.push(event)
    const final = events.find((event) => event.type === "usage")
    expect(final).toBeDefined()
    expect(final!.type === "usage" && final!.cost.source).toBe("provider")
    expect(final!.type === "usage" && Math.round(final!.cost.usd * 1_000_000)).toBe(123)

    const event = onlyEvent(hub)
    expect(event.cost.source).toBe("provider")
    expect(Math.round(event.cost.usd * 1_000_000)).toBe(123)
    expect(event.tags?.[PROVIDER_COST_RAW_TAG]).toBe("0.000123")
  })

  it("gives the same micro-USD result for the string and the number shape", async () => {
    const hub = await makeHub()
    await hub.generate(request("ok:deepseek-chat"))
    await hub.generate(request("number:deepseek-chat"))
    const [numberEvent, stringEvent] = hub.usage.query({ appId: APP_ID, limit: 50 }).events
    expect(Math.round(stringEvent!.cost.usd * 1_000_000)).toBe(123)
    expect(Math.round(numberEvent!.cost.usd * 1_000_000)).toBe(123)
    expect(stringEvent!.cost.source).toBe("provider")
    expect(numberEvent!.cost.source).toBe("provider")
  })
})

describe("A2 — no reported amount: the pre-G73 path, unchanged", () => {
  it("keeps the catalogue estimate and adds no tags", async () => {
    const hub = await makeHub()
    const control = controlCost(hub)
    expect(control.usd).toBeGreaterThan(0)

    const response = await hub.generate(request("nocost:deepseek-chat", { route: "test" }))
    // Deep equality against the *unchanged* estimator: same object, same source,
    // same numbers as before this feature existed.
    expect(response.cost).toEqual(control)
    expect(response.cost.source).toBe("manual")

    const event = onlyEvent(hub)
    expect(event.cost).toEqual(control)
    expect(event.tags).toEqual({ route: "test" })
    expect(event.tags?.[PROVIDER_COST_RAW_TAG]).toBeUndefined()
    expect(Object.keys(event.tags ?? {})).toEqual(["route"])
  })

  it("returns the same readOpenAiUsage shape when the body reports no amount", async () => {
    const body = completion(USAGE_COST)
    const { readOpenAiUsage } = await import("../src/fetch.js")
    const parsed = readOpenAiUsage(body as unknown as Record<string, unknown>)
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed!).sort()).toEqual(["model", "usage"])
    expect(parsed!.usage).toEqual({ input: 1200, output: 300, cacheRead: 800, cacheWrite: 0, reasoning: 64 })
  })

  it("keeps the stream path identical when nothing is reported", async () => {
    const hub = await makeHub()
    const control = controlCost(hub)
    const events = []
    for await (const event of hub.stream(request("stream-nocost:deepseek-chat"))) events.push(event)
    const final = events.find((event) => event.type === "usage")
    expect(final).toBeDefined()
    expect(final!.type === "usage" && final!.cost.source).toBe("manual")
    const event = onlyEvent(hub)
    expect(event.cost).toEqual(control)
    expect(event.tags).toEqual({})
  })
})

describe("A3 — an unusable amount never becomes a silent zero and never throws", () => {
  const cases: ReadonlyArray<{ id: string; raw: string | null; status: string }> = [
    { id: "text", raw: "abc", status: "rejected: not a decimal amount" },
    { id: "negative", raw: "-1", status: "rejected: negative amount" },
    { id: "huge", raw: "1e+300", status: "rejected: amount out of range" },
  ]

  for (const scenario of cases) {
    it(`falls back to the catalogue for ${scenario.id} (${scenario.raw})`, async () => {
      const hub = await makeHub()
      const control = controlCost(hub)
      const response = await hub.generate(request(`${scenario.id}:deepseek-chat`))

      expect(response.cost).toEqual(control)
      expect(response.cost.source).toBe("manual")
      expect(response.cost.usd).toBeGreaterThan(0)

      const event = onlyEvent(hub)
      expect(event.cost.usd).toBeGreaterThan(0)
      expect(event.cost.source).not.toBe("provider")
      expect(event.tags?.[PROVIDER_COST_RAW_TAG]).toBe(scenario.raw)
      expect(event.tags?.[PROVIDER_COST_STATUS_TAG]).toBe(scenario.status)
    })
  }

  it("treats a null amount as 'not reported' and still refuses to write zero", async () => {
    const hub = await makeHub()
    const control = controlCost(hub)
    const response = await hub.generate(request("null:deepseek-chat"))

    expect(response.cost).toEqual(control)
    expect(response.cost.usd).toBeGreaterThan(0)
    const event = onlyEvent(hub)
    expect(event.cost.source).toBe("manual")
    expect(event.tags?.[PROVIDER_COST_RAW_TAG]).toBeUndefined()
  })

  it("does not throw for any abnormal amount on the stream path either", async () => {
    const hub = await makeHub()
    const control = controlCost(hub)
    for (const id of ["stream-text", "stream-negative", "stream-huge"]) {
      const events = []
      for await (const event of hub.stream(request(`${id}:deepseek-chat`))) events.push(event)
      expect(events.some((event) => event.type === "error"), `${id} must not error`).toBe(false)
      const final = events.find((event) => event.type === "usage")
      expect(final, `${id} must report usage`).toBeDefined()
      expect(final!.type === "usage" && final!.cost.source).toBe("manual")
      expect(final!.type === "usage" && final!.cost.usd).toBeGreaterThan(0)
    }
    const recorded = hub.usage.query({ appId: APP_ID, limit: 50 }).events
    expect(recorded).toHaveLength(3)
    for (const event of recorded) {
      expect(event.cost).toEqual(control)
      expect(event.tags?.[PROVIDER_COST_STATUS_TAG]).toMatch(/^rejected: /)
    }
  })
})

describe("A5 — the two kinds of money are distinguishable", () => {
  it("says 'provider' in the export's pricing_source column and 'manual' for an estimate", async () => {
    const hub = await makeHub()
    await hub.generate(request("ok:deepseek-chat"))
    await hub.generate(request("nocost:deepseek-chat"))
    const events = hub.usage.query({ appId: APP_ID, limit: 50 }).events
    const rows = usageCsv(events).trim().split("\n")
    const columns = rows[0]!.split(",")
    const sourceAt = columns.indexOf("pricing_source")
    expect(sourceAt).toBeGreaterThan(-1)
    const sources = rows.slice(1).map((row) => row.split(",")[sourceAt])
    expect(sources.sort()).toEqual(["manual", "provider"])
    expect(USAGE_CSV_COLUMNS[sourceAt]).toBe("pricing_source")
  })

  it("shows the source column in `usage logs` (zh), so a host can see who said the price", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mik-g73-cli-"))
    tempDirs.push(dir)
    const db = join(dir, "usage.db")
    const hub = await makeHub({ db })
    await hub.generate(request("ok:deepseek-chat"))
    await hub.generate(request("nocost:deepseek-chat"))
    await hub.close()

    const out: string[] = []
    const err: string[] = []
    const code = await main(
      ["usage", "logs", "--offline", "--db", db, "--cache-dir", join(dir, "cache"), "--config", join(dir, "mik.config.json"), "--app-id", APP_ID],
      { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, cwd: dir, env: { ...process.env, MIK_LANG: "zh" }, interactive: false },
    )
    expect(code).toBe(0)
    const stdout = out.join("\n")
    expect(stdout).toContain("价格来源")
    expect(stdout).toContain("provider")
    expect(stdout).toContain("manual")
    // Offline mode legitimately warns about the catalogue source; the point here
    // is that the command itself did not fail.
    expect(err.join("\n")).not.toContain("错误")
  })
})

describe("A4 — the contract documents the new value and the two meanings", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/interfaces.md", import.meta.url)), "utf8")
  /** The fenced `PriceSource` block of the EVO-G73 section. */
  const union = /export type PriceSource =([\s\S]*?)```/.exec(doc)?.[1] ?? ""

  it("exposes the reading type through the package barrel, so a host can name it", () => {
    const reading: ProviderCostReading = { kind: "absent" }
    expect(providerCostTags(reading)).toEqual({})
    // The fetch contract must name the field too (rule 5).
    expect(doc).toContain("providerCost?: ProviderCostReading")
    expect(doc).toContain("cost?: ProviderCostReading } | null")
  })

  it("lists all six PriceSource values, including the new 'provider'", () => {
    for (const value of ["override", "modelsdev", "openrouter", "fallback", "provider", "missing"]) {
      expect(union, value).toContain(`| "${value}"`)
    }
    expect(union).toContain("★ 新增")
  })

  it("spells out that openrouter is a catalogue and provider is a bill", () => {
    expect(doc).toContain("一个是价目表、一个是账单")
    expect(doc).toContain("看到 `\"openrouter\"` **不等于**对账已闭合")
  })

  it("documents the reserved tag keys and the refusal to guess units", () => {
    expect(doc).toContain("provider_cost_raw")
    expect(doc).toContain("provider_cost_status")
    expect(doc).toContain("猜错就是 10^6 倍的静默错账")
  })
})
