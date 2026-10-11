import { describe, expect, it } from "vitest"
import { normalizePromptForCache as key } from "../src/cache/normalizer.js"
import { LruCache } from "../src/cache/lru.js"
import { Store } from "../src/store/database.js"

const messages = (content: string) => [{ role: "user", content }]
const deterministic = { temperature: 0, model: "p:m" }

describe("normalized deterministic cache", () => {
  it("collapses redundant text whitespace without changing message order", () => {
    expect(key(messages("  hello\n  world  "), deterministic)).toBe(key(messages("hello world"), deterministic))
    expect(key([{ role: "user", content: "a" }, { role: "assistant", content: "b" }], deterministic))
      .not.toBe(key([{ role: "assistant", content: "b" }, { role: "user", content: "a" }], deterministic))
  })
  it("recursively orders JSON keys but preserves JSON string values and array order", () => {
    expect(key(messages('{"b":{"z":2,"a":1},"a":0}'), deterministic)).toBe(key(messages('{ "a":0, "b":{"a":1,"z":2}}'), deterministic))
    expect(key(messages('{"a":"x  y"}'), deterministic)).not.toBe(key(messages('{"a":"x y"}'), deterministic))
    expect(key(messages('[1,2]'), deterministic)).not.toBe(key(messages('[2,1]'), deterministic))
  })
  it("normalizes tool definitions and tool-call JSON arguments", () => {
    const a = { name: "a", description: " hello  world ", parameters: { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } } }
    const b = { name: "b", parameters: { type: "object" } }
    expect(key(messages("hello"), { ...deterministic, tools: [b, a] })).toBe(key(messages("hello"), { ...deterministic, tools: [a, b] }))
    expect(key(messages("hello"), { ...deterministic, tools: { b, a } })).toBe(key(messages("hello"), { ...deterministic, tools: { a: { ...a, description: "hello world" }, b } }))
    const call = (input: string) => [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "a", input }] }]
    expect(key(call('{"b":2,"a":1}'), deterministic)).toBe(key(call('{"a":1,"b":2}'), deterministic))
  })
  it("rejects stochastic defaults, explicit bypass and no-cache regardless of opt-in", () => {
    expect(key(messages("a"))).toBeNull()
    expect(key(messages("a"), { temperature: 1 })).toBeNull()
    expect(key(messages("a"), { cache: true })).toMatch(/^[a-f0-9]{64}$/)
    expect(key(messages("a"), { ...deterministic, cache: false })).toBeNull()
    expect(key(messages("a"), { cache: true, headers: { "X-Mik-No-Cache": "true" } })).toBeNull()
  })
  it("isolates model, parameters, system and refuses credentials and executable tools", () => {
    const baseline = key(messages("a"), deterministic)
    for (const extra of [{ model: "q:m" }, { maxTokens: 2 }, { system: "other" }, { reasoning: true }, { batch: true }]) expect(key(messages("a"), { ...deterministic, ...extra })).not.toBe(baseline)
    expect(key(messages("api_key=abc"), deterministic)).toBeNull()
    expect(key(messages('{"token":"abc"}'), deterministic)).toBeNull()
    expect(key(messages("a"), { ...deterministic, headers: { Authorization: "Bearer abc" } })).toBeNull()
    expect(key(messages("a"), { ...deterministic, tools: { a: { execute: () => 1 } } })).toBeNull()
  })
  it("expires entries and evicts least recently used; values are isolated", () => {
    let now = 0
    const cache = new LruCache<{ text: string }>({ ttlMs: 10, maxEntries: 2 }, undefined, "a", () => now)
    cache.set("a", { text: "a" }); cache.set("b", { text: "b" })
    cache.get("a")!.text = "changed"
    cache.set("c", { text: "c" })
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("a")?.text).toBe("a")
    now = 10
    expect(cache.get("a")).toBeUndefined()
  })
  it("persists LRU order with namespace isolation and TTL", async () => {
    const store = await Store.open({ path: ":memory:" })
    try {
      const first = new LruCache({ maxEntries: 2, ttlMs: 10 }, store.driver, "a", () => 0)
      first.set("a", "A"); first.set("b", "B"); first.get("a"); first.set("c", "C")
      const second = new LruCache({ maxEntries: 2, ttlMs: 10 }, store.driver, "a", () => 1)
      expect(second.get("a")).toBe("A"); expect(second.get("b")).toBeUndefined()
      expect(new LruCache({}, store.driver, "b").get("a")).toBeUndefined()
      expect(new LruCache({}, store.driver, "a", () => 10).get("a")).toBeUndefined()
    } finally { store.close() }
  })
  it("rejects invalid cache limits", () => {
    for (const options of [{ ttlMs: 0 }, { maxEntries: -1 }, { ttlMs: 1.5 }]) expect(() => new LruCache(options)).toThrow()
  })
})
