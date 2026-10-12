import assert from "node:assert/strict"
import { test } from "node:test"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"

test("webhook monitor has complete bilingual statuses including queued versus delivered and failure", () => {
  const keys = Object.keys(en).filter(key => key.startsWith("webhooks.")) as (keyof typeof en)[]
  assert.deepEqual(keys.sort(), Object.keys(zh).filter(key => key.startsWith("webhooks.")).sort())
  for (const key of keys) {
    assert.ok(en[key].trim() && zh[key].trim())
    assert.doesNotMatch(en[key], /\p{Script=Han}/u)
  }
  assert.notEqual(en["webhooks.queued"], en["webhooks.delivered"])
  assert.notEqual(en["webhooks.testQueued"], en["webhooks.testFailed"])
})
