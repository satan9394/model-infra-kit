// Seed the dashboard with fake data.
//
// The dashboard reads `mik serve` over HTTP and never touches SQLite, but a
// *seeder* has to write somewhere: this script writes straight into the same
// store the server reads, through the package's public API (`Store`,
// `UsageService`, `ProviderRegistry`). No network, no provider keys, no
// pricing catalogue download.
//
// Usage:
//   pnpm --filter @mik/dashboard seed
//   pnpm --filter @mik/dashboard seed -- --days 14 --events 60 --no-reset
//   MIK_DB=./.tmp/demo.db MIK_APP_ID=demo pnpm --filter @mik/dashboard seed
//
// Options: --db <path>  --app-id <id>  --days <n>  --events <n>  --no-reset
//
// Precondition: `pnpm --filter model-infra-kit build` (the package exports
// point at dist/). The script says so explicitly if dist is missing.

import { homedir } from "node:os"

function parseArgs(argv) {
  const values = { days: 30, events: 120, reset: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--no-reset") values.reset = false
    else if (arg === "--db") values.db = argv[++index]
    else if (arg === "--app-id") values.appId = argv[++index]
    else if (arg === "--days") values.days = Number(argv[++index])
    else if (arg === "--events") values.events = Number(argv[++index])
    else if (arg === "--help" || arg === "-h") values.help = true
    else if (arg?.startsWith("--")) throw new Error(`unknown flag: ${arg}`)
  }
  return values
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log("用法: node scripts/seed.mjs [--db <path>] [--app-id <id>] [--days 30] [--events 120] [--no-reset]")
  process.exit(0)
}

let mik
try {
  mik = await import("model-infra-kit")
} catch (error) {
  console.error("无法加载 model-infra-kit（它导出 dist/，需要先构建）：")
  console.error("  pnpm --filter model-infra-kit build")
  console.error(String(error))
  process.exit(1)
}

const { Store, UsageService, ProviderRegistry, CredentialStore, defaultDbPath } = mik

const serverUrl = (process.env.MIK_SERVER_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "")

/** The running server's appId wins, so seeded rows are visible in the dashboard. */
async function resolveAppId() {
  if (args.appId) return args.appId
  if (process.env.MIK_APP_ID) return process.env.MIK_APP_ID
  try {
    const response = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(1500) })
    if (response.ok) {
      const health = await response.json()
      if (typeof health.appId === "string" && health.appId) {
        console.log(`从 ${serverUrl}/api/health 读到 appId="${health.appId}"`)
        return health.appId
      }
    }
  } catch {
    // Server not running: fall back to the CLI default.
  }
  return "default"
}

const dbPath = args.db ?? process.env.MIK_DB ?? defaultDbPath()
const appId = await resolveAppId()

/* --------------------------------------------------------------- fake data */

/** Deterministic PRNG, so two runs produce the same charts. */
function mulberry32(seed) {
  return function next() {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(20260908)
const pick = (list) => list[Math.floor(random() * list.length)]
const between = (min, max) => min + Math.floor(random() * (max - min + 1))

const PROVIDERS = [
  {
    id: "mock-gateway",
    name: "Mock Gateway (本地假数据)",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:3212/v1",
    enabled: true,
    meta: { note: "seed 脚本写入，配合 scripts/mock-openai.mjs 可做连接测试" },
  },
  {
    id: "demo-gateway",
    name: "Demo Gateway (未启用)",
    protocol: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    apiKeyRef: "env:DEMO_GATEWAY_KEY",
    enabled: false,
    meta: { note: "seed 脚本写入的占位供应商" },
  },
]

const CATALOG = {
  "mock-gateway": [
    {
      modelId: "mock-chat-pro",
      displayName: "Mock Chat Pro",
      contextWindow: 128000,
      maxOutputTokens: 8192,
      capabilities: { text: true, image: false, toolCall: true, reasoning: false, structuredOutput: true },
      rates: { inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.07, cacheWritePerM: 0.3 },
    },
    {
      modelId: "mock-chat-lite",
      displayName: "Mock Chat Lite",
      contextWindow: 32768,
      maxOutputTokens: 4096,
      capabilities: { text: true, image: false, toolCall: true, reasoning: false, structuredOutput: false },
      rates: { inputPerM: 0.05, outputPerM: 0.2, cacheReadPerM: 0.01, cacheWritePerM: 0.05 },
    },
    {
      modelId: "mock-reasoner",
      displayName: "Mock Reasoner",
      contextWindow: 65536,
      maxOutputTokens: 16384,
      capabilities: { text: true, image: false, toolCall: false, reasoning: true, structuredOutput: false },
      rates: { inputPerM: 0.55, outputPerM: 2.19, cacheReadPerM: 0.14, cacheWritePerM: 0.55 },
    },
    {
      modelId: "mock-vision",
      displayName: "Mock Vision",
      contextWindow: 200000,
      maxOutputTokens: 8192,
      capabilities: { text: true, image: true, toolCall: true, reasoning: false, structuredOutput: true },
      rates: { inputPerM: 1.2, outputPerM: 4.5, cacheReadPerM: 0.3, cacheWritePerM: 1.2 },
    },
  ],
  "demo-gateway": [
    {
      modelId: "demo-mini",
      displayName: "Demo Mini",
      contextWindow: 16384,
      maxOutputTokens: 2048,
      capabilities: { text: true, image: false, toolCall: false, reasoning: false, structuredOutput: false },
      rates: { inputPerM: 0.02, outputPerM: 0.08 },
    },
    {
      modelId: "demo-embed-8k",
      displayName: "Demo Embed 8k",
      contextWindow: 8192,
      capabilities: { text: false, image: false, toolCall: false, reasoning: false, structuredOutput: false },
      rates: { inputPerM: 0.01 },
    },
  ],
}

const OVERRIDES = [
  { modelId: "mock-chat-pro", displayName: "Mock Chat Pro (谈判价)", inputPerM: 0.19, outputPerM: 0.88, cacheReadPerM: 0.05, cacheWritePerM: 0.21 },
  { modelId: "mock-reasoner", displayName: "Mock Reasoner (内部价)", inputPerM: 0.4, outputPerM: 1.6 },
]

const SOURCES = ["generate", "generate", "generate", "stream", "stream", "fetch"]

function costOf(rates, usage) {
  const perM = (tokens, rate) => (rate === undefined ? 0 : (tokens / 1_000_000) * rate)
  return (
    perM(usage.input, rates.inputPerM) +
    perM(usage.output, rates.outputPerM) +
    perM(usage.cacheRead, rates.cacheReadPerM) +
    perM(usage.cacheWrite, rates.cacheWritePerM)
  )
}

function buildEvents(count, days) {
  const choices = []
  for (const [providerId, models] of Object.entries(CATALOG)) {
    for (const model of models) {
      // `demo-embed-8k` is not a chat model: keep it in the catalogue, not in the logs.
      if (model.capabilities.text === false) continue
      choices.push({ providerId, model })
    }
  }

  const now = Date.now()
  const events = []
  for (let index = 0; index < count; index += 1) {
    const { providerId, model } = pick(choices)
    const dayOffset = between(0, days - 1)
    const ts =
      now - dayOffset * 86_400_000 - between(0, 20) * 3_600_000 - between(0, 59) * 60_000
    const input = between(180, 18_000)
    const cacheRead = random() < 0.55 ? between(0, Math.floor(input * 0.8)) : 0
    const cacheWrite = random() < 0.3 ? between(0, 2_000) : 0
    const usage = {
      input,
      output: between(40, 3_800),
      cacheRead,
      cacheWrite,
      reasoning: model.capabilities.reasoning ? between(0, 1_200) : 0,
    }
    const failed = random() < 0.08
    const latencyMs = between(320, 4_800)
    const firstTokenMs = random() < 0.7 ? Math.max(60, Math.floor(latencyMs * 0.18)) : undefined
    const usd = failed ? 0 : costOf(model.rates, usage)
    const useOverride = model.modelId === "mock-chat-pro" || model.modelId === "mock-reasoner"

    events.push({
      requestId: `seed-${index.toString().padStart(4, "0")}-${Math.floor(random() * 1e6).toString(36)}`,
      ts,
      source: pick(SOURCES),
      providerId,
      modelRequested: `${providerId}:${model.modelId}`,
      modelActual: model.modelId,
      pricingModel: model.modelId,
      usage,
      cost: failed
        ? { usd: 0, low: 0, high: 0, basis: "flat", source: "missing" }
        : {
            usd,
            low: useOverride ? usd : usd * 0.85,
            high: useOverride ? usd : usd * 1.2,
            basis: useOverride ? "manual" : "flat",
            source: useOverride ? "override" : "modelsdev",
            pricingModel: model.modelId,
            providerId,
          },
      latencyMs,
      firstTokenMs,
      status: failed ? "error" : "ok",
      errorCode: failed ? pick(["RATE_LIMIT", "TIMEOUT", "PROVIDER"]) : undefined,
      isStreaming: random() < 0.4,
      sessionId: random() < 0.5 ? `sess-${between(1, 12)}` : undefined,
      tags: random() < 0.4 ? { env: pick(["dev", "staging", "prod"]), feature: pick(["chat", "summarize", "code"]) } : undefined,
      pricingBasis: failed ? "flat" : useOverride ? "manual" : "flat",
      pricingSource: failed ? "missing" : useOverride ? "override" : "modelsdev",
    })
  }
  return events
}

/* ------------------------------------------------------------------- write */

const store = await Store.open({ path: dbPath })
try {
  const credentials = new CredentialStore({ driver: store.driver })
  const registry = new ProviderRegistry({ store, credentials, appId })
  registry.seed(PROVIDERS)

  const now = Date.now()
  let modelCount = 0
  for (const [providerId, models] of Object.entries(CATALOG)) {
    modelCount += store.models.replaceForProvider(
      providerId,
      models.map((model) => ({
        providerId,
        modelId: model.modelId,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: {
          text: true,
          image: false,
          toolCall: false,
          reasoning: false,
          structuredOutput: false,
          ...model.capabilities,
        },
        source: "provider_api",
        syncedAt: now,
      })),
    )
  }

  for (const override of OVERRIDES) store.pricing.set(override)

  const usage = new UsageService({ store, appId, enabled: true })
  const cleared = args.reset ? usage.clear() : 0
  const events = buildEvents(Math.max(1, args.events), Math.max(1, args.days))
  let written = 0
  for (const event of events) if (usage.record(event)) written += 1

  const summary = usage.summary()
  const first = events.reduce((min, event) => Math.min(min, event.ts), Number.POSITIVE_INFINITY)
  const last = events.reduce((max, event) => Math.max(max, event.ts), 0)

  console.log("")
  console.log(`数据库   ${dbPath}`)
  console.log(`appId    ${appId}`)
  console.log(`供应商   ${PROVIDERS.length} 个（${PROVIDERS.map((p) => p.id).join(", ")}）`)
  console.log(`模型     ${modelCount} 条目录记录`)
  console.log(`手动价   ${OVERRIDES.length} 条`)
  console.log(`用量     ${written} 条（清空 ${cleared} 条旧记录）`)
  console.log(`区间     ${new Date(first).toLocaleString("zh-CN")} ~ ${new Date(last).toLocaleString("zh-CN")}`)
  console.log(`汇总     请求 ${summary.requests} · 失败 ${summary.failures} · 成本 $${summary.costUsd.toFixed(4)} · token ${summary.tokens.input + summary.tokens.output + summary.tokens.cacheRead + summary.tokens.cacheWrite + summary.tokens.reasoning}`)
  console.log("")
  console.log("下一步：")
  console.log(`  1. 启动上游  MIK_DB="${dbPath}" MIK_APP_ID=${appId} mik serve`)
  console.log("  2. 启动看板  pnpm --filter @mik/dashboard dev   → http://127.0.0.1:3210")
  console.log("  3.（可选）mock 供应商的连接测试：node apps/dashboard/scripts/mock-openai.mjs")
  console.log("")
} finally {
  store.close()
}
