import assert from "node:assert/strict"
import test from "node:test"
import { matchesCapabilities, latencyLevel } from "../lib/model-capabilities.ts"
import type { ModelInfo } from "../lib/types.ts"

const model: ModelInfo = { providerId: "p", modelId: "mini", ref: "p:mini", displayName: "Mini", source: "manual", contextWindow: 128_000, capabilities: { text: true, image: true, toolCall: false, reasoning: true, structuredOutput: false } }
test("capability selection intersects facts and exact long-context boundary", () => {
  assert.equal(matchesCapabilities(model, ["vision", "reasoning", "long"]), true)
  assert.equal(matchesCapabilities(model, ["vision", "tools"]), false)
  assert.equal(matchesCapabilities({ ...model, contextWindow: 127_999 }, ["long"]), false)
  assert.equal(matchesCapabilities({ ...model, contextWindow: undefined }, ["long"]), false)
})
test("Fast uses lightweight hints until measurement overrides them", () => {
  assert.equal(matchesCapabilities(model, ["fast"]), true)
  assert.equal(matchesCapabilities(model, ["fast"], 1001), false)
  assert.equal(matchesCapabilities({ ...model, modelId: "unknown" }, ["fast"]), false)
  assert.equal(matchesCapabilities({ ...model, modelId: "unknown" }, ["fast"], 1000), true)
})
test("four latency colors preserve missing and zero timings", () => {
  assert.deepEqual([null, undefined, -1, NaN, 0, 500, 501, 1500, 1501, 3000, 3001].map(latencyLevel), ["unknown", "unknown", "unknown", "unknown", "fast", "fast", "normal", "normal", "slow", "slow", "very-slow"])
})
