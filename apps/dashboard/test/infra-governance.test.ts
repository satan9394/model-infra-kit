import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { en } from "../lib/i18n/en.ts"
import { zh } from "../lib/i18n/zh.ts"
import { readFilters, resolveRange, usageQuery } from "../lib/range.ts"
import { readPlaygroundStream } from "../lib/playground.ts"

/**
 * EVO-G143 adversarial checks. Every expectation below is an *external* literal
 * (field names, status codes, anchor names, the pre-change dictionary size), so
 * a passing run cannot be produced by the implementation agreeing with itself.
 */
const EN = en as Record<string, string>
const ZH = zh as Record<string, string>
const en_ = (key: string): string => EN[key] ?? ""
const zh_ = (key: string): string => ZH[key] ?? ""

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8")
const panel = () => read("../components/quotas-panel.tsx")
const webhooks = () => read("../components/webhooks-panel.tsx")
const drawer = () => read("../components/playground-drawer.tsx")

const ADDED_KEYS = [
  "provider.sourceLabel",
  "provider.sourceFile",
  "provider.sourceFileDetail",
  "provider.statusDimensions",
  "model.catalogScope",
  "model.localScope",
  "model.contextFilter",
  "model.contextAny",
  "model.contextTokens",
  "quotas.guideTitle",
  "quotas.guideIntro",
  "quotas.guideRpm",
  "quotas.guideTpm",
  "quotas.guideDaily",
  "quotas.guideMonthly",
  "quotas.guideSnippet",
  "quotas.guideNote",
  "quotas.openLog",
  "webhooks.semanticsTitle",
  "webhooks.semanticsBody",
  "webhooks.deadLetterDetail",
  "webhooks.deadLetterError",
  "webhooks.timestampUnavailable",
  "playground.viewAttempts",
  "playground.traceRecorded",
  "logs.focusedDetail",
] as const

/** EVO-G144 durable outbox additions; tracked separately so the G143 snapshot stays meaningful. */
const G144_KEYS = [
  "webhooks.semanticsBodyDurable",
  "webhooks.outboxTitle",
  "webhooks.outboxModeDurable",
  "webhooks.outboxModeMemory",
  "webhooks.outboxPending",
  "webhooks.outboxProcessing",
  "webhooks.outboxDelivered",
  "webhooks.outboxDeadLetters",
  "webhooks.outboxRetry",
  "webhooks.outboxRetryShown",
  "webhooks.outboxRetryMemoryOnly",
  "webhooks.outboxUnavailable",
] as const

/** EVO-G145 embed bridge and a11y additions; tracked separately so earlier snapshots stay meaningful. */
const G145_KEYS = [
  "embed.bridgeReady",
  "embed.bridgeError",
  "a11y.liveConnected",
  "a11y.liveDisconnected",
] as const

/** EVO-G137 provider presets and model picker additions. */
const G137_KEYS = [
  "picker.title",
  "picker.count",
  "picker.search",
  "picker.all",
  "picker.none",
  "picker.onlySelected",
  "picker.empty",
  "picker.fromProvider",
  "picker.custom",
  "picker.context",
  "picker.vision",
  "picker.reasoning",
  "picker.tools",
  "picker.default",
  "picker.setDefault",
  "provider.console",
  "provider.presetHint",
] as const

/* ---------------------------------------------- adversarial 1: quota guide */

test("EVO-G143 quota empty state is a structured guide, not a thin blank", () => {
  const source = panel()
  assert.match(source, /data-testid="quota-guide"/)
  assert.match(source, /data-testid="quota-guide-snippet"/)
  assert.ok(en_("quotas.guideTitle").trim())
  assert.ok(en_("quotas.guideIntro").trim())
  // The previous single thin paragraph is no longer the empty state.
  assert.doesNotMatch(source, /data\.quotas\.length === 0 \? <p className="text-sm text-subtle">\{t\("quotas\.empty"\)\}<\/p>/)
})

test("EVO-G143 quota guide names every parameter with its real configuration field", () => {
  assert.match(en_("quotas.guideRpm"), /maxRpm/)
  assert.match(en_("quotas.guideTpm"), /maxTpm/)
  assert.match(en_("quotas.guideDaily"), /dailyHardCapMicros/)
  assert.match(en_("quotas.guideMonthly"), /monthlyHardCapMicros/)
  // Unconfigured is explained, and an explicit zero budget is distinguished.
  assert.match(en_("quotas.guideIntro"), /read only/)
  assert.match(en_("quotas.guideNote"), /403/)
})

test("EVO-G143 quota guide uses integer microdollar bigints, never floats", () => {
  const source = panel()
  assert.match(source, /dailyHardCapMicros: 5_000_000n/)
  assert.match(source, /monthlyHardCapMicros: 100_000_000n/)
  assert.doesNotMatch(source, /dailyHardCapMicros: 5\.0/)
  assert.match(en_("quotas.guideDaily"), /bigint/)
})

test("EVO-G143 a blocked quota request drills into the recorded request detail", () => {
  const source = panel()
  assert.match(source, /\/logs\?focusId=\$\{encodeURIComponent\(log\.requestId\)\}/)
  assert.match(source, /title=\{t\("quotas\.openLog"\)\}/)
  assert.match(source, /aria-label=\{t\("quotas\.openLog"\)\}/)
})

/* ------------------------------------------ adversarial 2: webhook honesty */

test("EVO-G143 webhook semantics are declared as best-effort without a durability promise", () => {
  const source = webhooks()
  assert.match(source, /data-testid="webhook-semantic-note"/)
  assert.match(source, /t\("webhooks\.semanticsTitle"\)/)
  assert.match(source, /t\("webhooks\.semanticsBody"\)/)
  assert.match(en_("webhooks.semanticsBody"), /best-effort/)
  assert.match(en_("webhooks.semanticsBody"), /restart/)
  assert.match(en_("webhooks.semanticsBody"), /never rolls back/)
  assert.doesNotMatch(en_("webhooks.semanticsBody"), /guarantee/i)
})

test("EVO-G143 dead letters expand into a bounded, wrapping detail region", () => {
  const source = webhooks()
  assert.match(source, /data-testid="webhook-dead-letters"/)
  assert.match(source, /<details/)
  assert.match(source, /<summary/)
  assert.match(source, /data-testid="webhook-dead-letter-summary"/)
  const errorLine = source.split("\n").find((line) => line.includes('data-testid="webhook-dead-letter-error"'))
  assert.ok(errorLine, "dead-letter error node must exist")
  // A multi-kilobyte upstream body wraps instead of widening the page.
  assert.match(errorLine!, /break-words/)
  assert.match(errorLine!, /\[overflow-wrap:anywhere\]/)
  assert.match(errorLine!, /whitespace-pre-wrap/)
  assert.match(errorLine!, /max-h-\d+ overflow-y-auto/)
  assert.doesNotMatch(errorLine!, /whitespace-nowrap/)
})

test("EVO-G143 the previous single-line dead-letter dump is gone and no timestamp is invented", () => {
  const source = webhooks()
  assert.doesNotMatch(source, /\{entry\.error\} · \{t\("webhooks\.attempts"\)\}/)
  assert.match(source, /\{t\("webhooks\.attempts"\)\}: \{entry\.attempts\}/)
  assert.match(source, /t\("webhooks\.timestampUnavailable"\)/)
  assert.match(en_("webhooks.timestampUnavailable"), /timestamp/)
  assert.match(en_("webhooks.deadLetterError"), /[Ee]rror/)
})

/* --------------------------------- adversarial 3: playground failure paths */

test("EVO-G143 an unauthorised playground request surfaces an HTTP status, not a raw crash", async () => {
  await assert.rejects(
    () => readPlaygroundStream(new Response("", { status: 401 }), () => {}),
    (error: Error) => {
      assert.equal(error.message, "HTTP 401")
      return true
    },
  )
  await assert.rejects(
    () => readPlaygroundStream(new Response("", { status: 403 }), () => {}),
    (error: Error) => {
      assert.equal(error.message, "HTTP 403")
      return true
    },
  )
})

test("EVO-G143 a streamed provider error is redacted before it reaches the UI", async () => {
  const failed = new Response('data: {"error":{"message":"Bearer sk-secret-token rejected"}}\n\n', { status: 200 })
  await assert.rejects(
    () => readPlaygroundStream(failed, () => {}),
    (error: Error) => {
      assert.doesNotMatch(error.message, /sk-secret-token/)
      assert.match(error.message, /rejected/)
      return true
    },
  )
})

test("EVO-G143 an empty playground prompt never reaches the network", () => {
  const source = drawer()
  assert.match(source, /if \(busy \|\| !prompt\.trim\(\)\) return/)
  assert.match(source, /disabled=\{busy \|\| !prompt\.trim\(\)\}/)
  assert.match(source, /<p role="alert"/)
  assert.match(source, /setError\(t\("playground\.stopped"\)\)/)
})

test("EVO-G143 a successful playground run links to the recorded attempt chain", () => {
  const source = drawer()
  assert.match(source, /data-testid="playground-log-link"/)
  assert.match(source, /\/logs\?focusId=\$\{encodeURIComponent\(recordedId\)\}/)
  assert.match(source, /setRecordedId\(recorded\.requestId\)/)
  assert.ok(en_("playground.viewAttempts").trim())
})

/* ----------------------------------------------- adversarial 4: dictionary */

test("EVO-G143 dictionary additions keep zh/en parity and identical placeholders", () => {
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, Object.keys(zh).sort())
  // Pre-change baseline was 679 keys; additions may only grow the surface.
  assert.ok(enKeys.length >= 679, `expected >= 679 keys, saw ${enKeys.length}`)
  // G144 appended its own documented keys on top of the G143 set, and G145 added
  // the embed bridge + a11y announcements. G135 adds the approximate-hit labels.
  // G137 adds the model picker and provider console/hint labels.
  assert.equal(enKeys.length, 679 + ADDED_KEYS.length + G144_KEYS.length + G145_KEYS.length + 2 + G137_KEYS.length)
  for (const key of [...ADDED_KEYS, ...G145_KEYS, ...G137_KEYS]) {
    assert.ok(enKeys.includes(key), `missing dictionary key: ${key}`)
    assert.ok(en_(key).trim() && zh_(key).trim(), key)
    assert.deepEqual(zh_(key).match(/\{\d+\}/g) ?? [], en_(key).match(/\{\d+\}/g) ?? [], key)
    assert.doesNotMatch(en_(key), /\p{Script=Han}/u, key)
  }
  assert.match(en_("model.contextTokens"), /\{0\}/)
  assert.match(en_("playground.traceRecorded"), /\{0\}/)
})

test("EVO-G143 no legacy dictionary key was dropped", () => {
  const enKeys = Object.keys(en)
  for (const key of ["quotas.empty", "webhooks.queued", "provider.connected", "model.catalogScope", "s0", "price.fallback"]) {
    assert.ok(enKeys.includes(key), key)
  }
  assert.equal(en_("quotas.empty"), "No tenant quotas configured.")
  assert.equal(zh_("quotas.empty"), "尚未配置租户配额。")
})

/* -------------------------------------- providers / models / deep linking */

test("EVO-G143 provider cards state the configuration source and separate probe from breaker", () => {
  const source = read("../components/providers-client.tsx")
  assert.match(source, /data-testid="provider-source-badge"/)
  assert.match(source, /data-testid="provider-status-dimensions"/)
  assert.match(source, /t\("provider\.sourceFile"\)/)
  assert.match(source, /t\("provider\.sourceFileDetail"\)/)
  // The pre-existing probe/circuit separation is untouched.
  assert.match(source, /signal=\{\{ kind: "probe"/)
  assert.match(source, /signal=\{\{ kind: "circuit"/)
  assert.match(en_("provider.statusDimensions"), /independent/)
  assert.match(en_("provider.sourceLabel"), /source/i)
  assert.match(en_("provider.sourceFileDetail"), /isolatedProviders/)
  // The source note never asks for or re-displays a raw credential.
  assert.doesNotMatch(en_("provider.sourceFileDetail"), /API key|apiKeyRef/)
})

test("EVO-G143 model catalogue and local scopes stay distinct under the context filter", () => {
  const source = read("../components/views/models.tsx")
  assert.match(source, /data-testid="model-context-filter"/)
  assert.match(source, /data-testid="model-catalog-scope"/)
  assert.match(source, /data-testid="model-local-scope"/)
  // The context filter really narrows both the catalogue and the local list.
  assert.match(source, /minContext && model\.contextWindow < Number\(minContext\)/)
  assert.match(source, /minContext && \(model\.contextWindow \?\? 0\) < Number\(minContext\)/)
  assert.match(en_("model.catalogScope"), /not necessarily callable/i)
  assert.match(en_("model.localScope"), /synced/i)
  assert.match(en_("model.contextAny"), /[Cc]ontext window/)
})

test("EVO-G143 focusId deep link opens one request detail and never becomes a list filter", () => {
  const filters = readFilters({ focusId: "req-deep-link", provider: "p1" })
  assert.equal(filters.focusId, "req-deep-link")
  const range = resolveRange({ range: "7d" }, 1_700_000_000_000)
  const query = usageQuery(range, filters)
  assert.match(query, /provider=p1/)
  // The deep link must not leak into the usage API as a list filter.
  assert.doesNotMatch(query, /focusId|req-deep-link/)
  // Oversized and blank ids are rejected rather than forwarded.
  assert.equal(readFilters({ focusId: "x".repeat(201) }).focusId, undefined)
  assert.equal(readFilters({ focusId: "   " }).focusId, undefined)
  // The logs view consumes it and the list client opens on mount.
  assert.match(read("../components/views/logs.tsx"), /initialId=\{filters\.focusId\}/)
  assert.match(read("../components/logs-client.tsx"), /useState<string \| null>\(initialId \?\? null\)/)
})

/* ------------------------------------------------ EVO-G144 durable outbox */

test("EVO-G144 dictionary additions keep zh/en parity and identical placeholders", () => {
  const enKeys = Object.keys(en)
  for (const key of G144_KEYS) {
    assert.ok(enKeys.includes(key), `missing dictionary key: ${key}`)
    assert.ok(en_(key).trim() && zh_(key).trim(), key)
    assert.deepEqual(zh_(key).match(/\{\d+\}/g) ?? [], en_(key).match(/\{\d+\}/g) ?? [], key)
    assert.doesNotMatch(en_(key), /\p{Script=Han}/u, key)
  }
  assert.match(en_("webhooks.outboxRetryShown"), /\{0\}/)
})

test("EVO-G144 the webhook page states the active delivery mode and offers dead-letter retry", () => {
  const source = webhooks()
  // The required anchor, and both mode labels the card must be able to show.
  assert.match(source, /data-testid="webhook-outbox-status"/)
  assert.match(source, /t\("webhooks\.outboxModeDurable"\)/)
  assert.match(source, /t\("webhooks\.outboxModeMemory"\)/)
  // It reads the real queue endpoints, not a fabricated counter.
  assert.match(source, /\/webhooks\/outbox\/stats/)
  assert.match(source, /\/webhooks\/outbox\/retry-dead/)
  assert.match(source, /t\("webhooks\.outboxRetry"\)/)
  // Retrying is refused in memory mode instead of pretending to succeed.
  assert.match(source, /mode !== "durable"/)
  // The counters are the real queue numbers, explicit keys included.
  assert.match(source, /\["webhooks\.outboxPending", outbox\.pending\]/)
  assert.match(source, /\["webhooks\.outboxProcessing", outbox\.processing\]/)
  assert.match(source, /\["webhooks\.outboxDelivered", outbox\.delivered\]/)
  assert.match(source, /\["webhooks\.outboxDeadLetters", outbox\.deadLetter\]/)
  assert.match(source, /\["webhooks\.dropped", outbox\.dropped\]/)
  // In durable mode the always-zero in-memory counters and the always-empty
  // in-memory "No failed deliveries." list must both be hidden, or the page
  // prints contradictory numbers side by side.
  assert.match(source, /\{!durable \? <dl[^>]*data-testid="webhook-counters">/)
  assert.match(source, /\{!durable \? <>[\s\S]{0,200}?t\("webhooks\.deadLetters"\)/)
  // The semantics note states the truth for whichever mode is active.
  assert.match(source, /t\("webhooks\.semanticsBodyDurable"\)/)
  assert.match(source, /t\("webhooks\.semanticsBody"\)/)
  assert.match(en_("webhooks.semanticsBodyDurable"), /at-least-once/)
  assert.match(en_("webhooks.semanticsBodyDurable"), /X-Mik-Delivery-Id/)
  assert.doesNotMatch(en_("webhooks.semanticsBodyDurable"), /guarantee/i)
})
