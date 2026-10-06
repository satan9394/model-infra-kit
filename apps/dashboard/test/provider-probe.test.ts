import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { apiCall } from "../lib/client-api.ts"
import { createProvider } from "../lib/provider-create.ts"
import { emptyProviderDraft, buildCreateProviderPayload } from "../lib/provider-presets.ts"
import { providerProbeError, providerStatusText } from "../lib/provider-status.ts"
import { translator } from "../lib/i18n/core.ts"
import { zh } from "../lib/i18n/zh.ts"

test("provider statuses use structured fields in both languages, never backend English", () => {
  const status = { providerId: "test", ok: true, checkedAt: 0, message: "Connected. The provider reports secret", modelCount: 0, latencyMs: 0 }
  assert.equal(providerStatusText(status, translator("zh")), "已连通（共 0 款模型，延迟 0 ms）")
  assert.equal(providerStatusText(status, translator("en")), "Connected (0 models, 0 ms latency)")
  assert.doesNotMatch(providerStatusText({ ...status, ok: false }, translator("zh")), /Connected|secret/)
  for (const key of ["s23", "s112", "s123", "s226", "s267", "s388"] as const) assert.doesNotMatch(zh[key], / \/ /)
})

test("probe calls the authenticated proxy with its abort signal and reference only", async (context) => {
  const controller = new AbortController()
  context.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    assert.equal(path, "/api/mik/providers/probe")
    assert.equal(init.signal, controller.signal)
    assert.deepEqual(JSON.parse(String(init.body)), { protocol: "openai-compatible", apiKeyRef: "env:TEST_KEY" })
    return new Response(JSON.stringify({ status: { ok: true }, models: [] }))
  })
  const result = await apiCall("/providers/probe", { method: "POST", body: { protocol: "openai-compatible", apiKeyRef: "env:TEST_KEY" }, signal: controller.signal })
  assert.equal(result.ok, true)
})

test("probe errors localize every actionable classification and retain redacted upstream details", () => {
  const keys = { AUTH: "provider.probeAuth", CREDENTIAL: "provider.probeCredential", RATE_LIMIT: "provider.probeRateLimit", PROVIDER: "provider.probeProvider", CONNECTION: "provider.offline", UNKNOWN: "provider.offline" }
  for (const lang of ["zh", "en"] as const) {
    const t = translator(lang)
    for (const [errorCode, key] of Object.entries(keys)) {
      assert.equal(providerProbeError({ errorCode, message: "HTTP 401 [REDACTED]" }, t), t("provider.probeErrorDetail", t(key), "HTTP 401 [REDACTED]"))
    }
    assert.equal(providerProbeError({ errorCode: "TIMEOUT", message: "upstream timed out" }, t), t("provider.probeTimeout"))
    assert.equal(providerProbeError({ message: "" }, t), t("provider.offline"))
  }
})

test("chosen default is applied after creation and discovery with namespaced model encoding", async (context) => {
  const paths: string[] = []
  context.mock.method(globalThis, "fetch", async (path: string, init: RequestInit) => {
    paths.push(path)
    assert.equal(init.method, paths.length === 3 ? "PUT" : "POST")
    return new Response("{}")
  })
  const parsed = buildCreateProviderPayload({ ...emptyProviderDraft(), id: "gateway", baseUrl: "https://example.com/v1" })
  assert.ok(parsed.ok)
  assert.deepEqual(await createProvider(parsed.value, "org/model"), { ok: true, data: { defaultError: null } })
  assert.deepEqual(paths, ["/api/mik/providers", "/api/mik/providers/gateway/models/refresh", "/api/mik/models/gateway%3Aorg%2Fmodel/default"])
})

test("default discovery failure preserves saved provider and never retries creation", async (context) => {
  const paths: string[] = []
  context.mock.method(globalThis, "fetch", async (path: string) => {
    paths.push(path)
    return paths.length === 1 ? new Response("{}") : new Response('{"error":{"message":"Unavailable"}}', { status: 502 })
  })
  const parsed = buildCreateProviderPayload({ ...emptyProviderDraft(), id: "gateway" })
  assert.ok(parsed.ok)
  const result = await createProvider(parsed.value, "model")
  assert.ok(result.ok)
  assert.match(result.data.defaultError!, /502/)
  assert.deepEqual(paths, ["/api/mik/providers", "/api/mik/providers/gateway/models/refresh"])
})

test("modal preserves provider anchor, caps tags and invalidates stale probe results", () => {
  const source = readFileSync(new URL("../components/add-provider-modal.tsx", import.meta.url), "utf8")
  assert.match(source, /id="provider-id"/)
  assert.match(source, /models\.slice\(0, 50\)/)
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), 5000\)/)
  assert.match(source, /probeController\.current !== controller/)
  assert.match(source, /patch\.baseUrl !== undefined \|\| patch\.apiKeyRef !== undefined \|\| patch\.protocol !== undefined/)
  assert.doesNotMatch(source, /grid-cols-4 xl:grid-cols-7/)
})

test("visible request, pricing and model enum labels use dictionaries instead of raw API values", () => {
  const read = (path: string) => readFileSync(new URL(`../components/${path}.tsx`, import.meta.url), "utf8")
  const trace = read("trace-waterfall")
  assert.doesNotMatch(trace, /· Prompt |\/ Reasoning |\/ Completion |\{event\.status\}/)
  for (const key of ["ping.prompt", "ping.reasoning", "ping.completion"]) assert.ok(trace.includes(`t("${key}")`))
  assert.doesNotMatch(read("logs-client"), />\{event\.status\}<\/Badge>/)
  assert.doesNotMatch(read("views/overview"), /pricing \{shell\.health\.pricing\.status\}/)
  assert.doesNotMatch(read("views/models"), /· \{binding\.status\}/)
  assert.doesNotMatch(read("model-card"), /· \{model\.source\}/)
  assert.doesNotMatch(read("providers-client"), />\{model\.source\}<\/span>/)
  const t = translator("zh")
  assert.equal(t("model.source.provider_api"), "供应商接口")
  assert.equal(t("model.source.models_dev"), "models.dev")
  assert.equal(t("model.status.deprecated"), "已弃用")
  assert.equal(t("pricing.error"), "同步失败")
  assert.equal(t("price.source.manual"), "手动定价")
  assert.equal(translator("en")("price.source.manual"), "Manual pricing")
  assert.equal(translator("en")("model.status.available"), "Available")
  assert.match(t("s14"), /自定义网关必须/)
})
