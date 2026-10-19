import assert from "node:assert/strict"
import test from "node:test"
import { filterModels, pickerModels, selectVisible, selectedModelIds, type PickerModel } from "../lib/model-picker.ts"

const M1: PickerModel = { modelId: "gpt-4o", displayName: "GPT-4o", vendor: "OpenAI", contextWindow: 128000 }
const M2: PickerModel = { modelId: "gpt-4o-mini", displayName: "GPT-4o Mini", vendor: "OpenAI", contextWindow: 128000 }
const M3: PickerModel = { modelId: "claude-3-7-sonnet", displayName: "Claude 3.7", vendor: "Anthropic" }
const MODELS = [M1, M2, M3]

test("pickerModels merges remote models and custom/saved selections without duplicate IDs", () => {
  const merged = pickerModels(MODELS, ["gpt-4o", "custom-model"])
  assert.equal(merged.length, 4)
  assert.equal(merged[0]?.modelId, "gpt-4o")
  assert.equal(merged[3]?.modelId, "custom-model")
  assert.equal(merged[3]?.displayName, undefined)
})

test("filterModels filters by search query matching modelId, displayName and vendor", () => {
  assert.deepEqual(filterModels(MODELS, ["gpt-4o"], "mini", false).map(m => m.modelId), ["gpt-4o-mini"])
  assert.deepEqual(filterModels(MODELS, ["gpt-4o"], "anthropic", false).map(m => m.modelId), ["claude-3-7-sonnet"])
  assert.deepEqual(filterModels(MODELS, ["gpt-4o"], "gpt", false).map(m => m.modelId), ["gpt-4o", "gpt-4o-mini"])
})

test("filterModels respects onlySelected flag", () => {
  assert.deepEqual(filterModels(MODELS, ["claude-3-7-sonnet"], "", true).map(m => m.modelId), ["claude-3-7-sonnet"])
  assert.deepEqual(filterModels(MODELS, ["claude-3-7-sonnet"], "gpt", true).map(m => m.modelId), [])
})

test("selectVisible adds and removes only currently visible matching items", () => {
  const visible = [M1, M2]
  const initial = ["claude-3-7-sonnet"]
  const allSelected = selectVisible(initial, visible, true)
  assert.deepEqual(allSelected.sort(), ["claude-3-7-sonnet", "gpt-4o", "gpt-4o-mini"].sort())

  const noneSelected = selectVisible(allSelected, visible, false)
  assert.deepEqual(noneSelected, ["claude-3-7-sonnet"])
})

test("selectedModelIds validates, trims, and deduplicates string arrays", () => {
  assert.equal(selectedModelIds(null), undefined)
  assert.equal(selectedModelIds("gpt-4o"), undefined)
  assert.equal(selectedModelIds([""]), undefined)
  assert.deepEqual(selectedModelIds(["gpt-4o", "claude-3-7-sonnet", "gpt-4o"]), ["gpt-4o", "claude-3-7-sonnet"])
})
