/**
 * Example host: a self-built CLI agent.
 *
 * This is the "embedded library" access surface from `docs/SPEC.md` §2.1. It
 * walks the acceptance scenario of §6 end to end through the public API only:
 *
 *   init → add provider → test connection → discover models → set default →
 *   generate → stream → tool call → usage summary
 *
 * Run it against any OpenAI-compatible endpoint (a local mock is fine):
 *
 *   pnpm --filter @mik/example-cli-agent start -- --base-url http://127.0.0.1:3211/v1
 *
 * Nothing here reads a secret from the database: `apiKeyRef` is a reference
 * (`env:VAR`, `file:path`), and a keyless local endpoint is supported too.
 */
import { parseArgs } from "node:util"
import { jsonSchema, tool } from "ai"
import { ModelInfra } from "model-infra-kit"

/** Keeps the example offline by default: the bundled price archive still prices. */
const offlineFetch: typeof globalThis.fetch = async () => {
  throw new Error("offline: the example does not fetch the price catalogue")
}

function usage(message: string): never {
  process.stderr.write(`${message}\n`)
  process.stderr.write(
    "usage: index.ts [--base-url <url>] [--provider <id>] [--model <id>] [--db <path>] " +
      "[--app-id <id>] [--api-key-ref <ref>] [--online-pricing]\n",
  )
  process.exit(2)
}

const { values } = parseArgs({
  // A `--` separator (as `pnpm start -- --flag` produces) is dropped: these
  // examples take no positional arguments.
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  options: {
    "base-url": { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    db: { type: "string" },
    "app-id": { type: "string" },
    "api-key-ref": { type: "string" },
    "online-pricing": { type: "boolean" },
  },
  allowPositionals: true,
  strict: true,
})

const baseUrl = values["base-url"] ?? process.env.MIK_EXAMPLE_BASE_URL ?? "http://127.0.0.1:3211/v1"
const providerId = values.provider ?? process.env.MIK_EXAMPLE_PROVIDER ?? "local"
const modelOverride = values.model ?? process.env.MIK_EXAMPLE_MODEL
const db = values.db ?? process.env.MIK_DB ?? "example-cli-agent.db"
const appId = values["app-id"] ?? process.env.MIK_APP_ID ?? "example-cli-agent"
const cacheDir = process.env.MIK_CACHE_DIR
const apiKeyRef = values["api-key-ref"] ?? process.env.MIK_EXAMPLE_API_KEY_REF
const onlinePricing = values["online-pricing"] === true || process.env.MIK_EXAMPLE_ONLINE_PRICING === "1"

const warnings: string[] = []
const step = (index: number, title: string): void => {
  process.stdout.write(`\n[${index}] ${title}\n`)
}

step(1, "ModelInfra.init()")
const mik = await ModelInfra.init({
  appId,
  db,
  cacheDir,
  // `pricingFetch` is the documented offline switch (docs/interfaces.md, T05).
  pricingFetch: onlinePricing ? undefined : offlineFetch,
  onWarn: (message) => warnings.push(message),
})
process.stdout.write(`    appId   ${mik.appId}\n`)
process.stdout.write(`    db      ${db}\n`)
process.stdout.write(`    baseUrl ${mik.baseUrl}\n`)
process.stdout.write(`    pricing ${mik.pricing.state().status} (source ${mik.pricing.state().source ?? "-"})\n`)

step(2, `add provider "${providerId}"`)
const record = mik.providers.add({
  id: providerId,
  name: "Example local provider",
  protocol: "openai-compatible",
  baseUrl,
  apiKeyRef,
})
process.stdout.write(`    protocol ${record.protocol}\n    baseUrl  ${record.baseUrl}\n`)
process.stdout.write(`    keyRef   ${record.apiKeyRef ?? "(none: keyless endpoint)"}\n`)

step(3, "test connection")
const status = await mik.ai.test(providerId)
process.stdout.write(`    ok        ${status.ok}\n`)
process.stdout.write(`    models    ${status.modelCount ?? "-"}\n`)
process.stdout.write(`    latency   ${status.latencyMs ?? "-"} ms\n`)
process.stdout.write(`    message   ${status.message}\n`)
if (!status.ok) usage(`the provider is not reachable at ${baseUrl}`)

step(4, "discover models")
const models = await mik.models.refresh(providerId)
if (models.length === 0) usage("the provider reported no models")
for (const model of models) {
  process.stdout.write(`    ${model.ref}  ctx=${model.contextWindow ?? "-"}  source=${model.source}\n`)
}

step(5, "set default model")
const chosen = modelOverride ?? models[0]!.modelId
const defaultRef = chosen.includes(":") ? chosen : `${providerId}:${chosen}`
mik.providers.setDefaultModel(defaultRef)
process.stdout.write(`    default ${mik.providers.defaultModel()}\n`)

step(6, "generate()")
const generated = await mik.generate({
  messages: [{ role: "user", content: "Say hello from the embedded library." }],
  sessionId: "cli-agent-generate",
  tags: { example: "cli-agent" },
})
process.stdout.write(`    text    ${JSON.stringify(generated.text.slice(0, 80))}\n`)
process.stdout.write(`    model   ${generated.model.actual}\n`)
process.stdout.write(`    usage   ${JSON.stringify(generated.usage)}\n`)
process.stdout.write(`    cost    $${generated.cost.usd} (source ${generated.cost.source})\n`)

step(7, "stream()")
const chunks: string[] = []
let streamCost = "$0"
for await (const event of mik.stream({
  messages: [{ role: "user", content: "Stream a short answer, please." }],
  sessionId: "cli-agent-stream",
  tags: { example: "cli-agent" },
})) {
  if (event.type === "text_delta") chunks.push(event.text)
  if (event.type === "usage") streamCost = `$${event.cost.usd}`
  if (event.type === "error") usage(`stream failed: ${event.error.code} ${event.error.message}`)
}
process.stdout.write(`    deltas  ${chunks.length}\n`)
process.stdout.write(`    text    ${JSON.stringify(chunks.join("").slice(0, 80))}\n`)
process.stdout.write(`    cost    ${streamCost}\n`)

step(8, "tool call")
const toolRuns: unknown[] = []
const result = await mik.generate({
  messages: [{ role: "user", content: "What is the weather in Beijing? Use the tool." }],
  tools: {
    get_weather: tool({
      description: "Look up the current weather for a city.",
      inputSchema: jsonSchema<{ city: string }>({
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
        additionalProperties: false,
      }),
      execute: async (input: { city: string }) => {
        toolRuns.push(input)
        return { city: input.city, tempC: 21, sky: "clear" }
      },
    }),
  },
  sessionId: "cli-agent-tool",
  tags: { example: "cli-agent" },
})
process.stdout.write(`    toolCalls ${result.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(", ") || "-"}\n`)
process.stdout.write(`    executed  ${JSON.stringify(toolRuns)}\n`)
process.stdout.write(`    steps     ${result.steps ?? 1}\n`)
process.stdout.write(`    text      ${JSON.stringify(result.text.slice(0, 80))}\n`)
process.stdout.write(`    cost      $${result.cost.usd} (source ${result.cost.source})\n`)

step(9, "usage summary")
const summary = mik.usage.summary()
process.stdout.write(
  [
    `    requests      ${summary.requests}`,
    `    successes     ${summary.successes}`,
    `    failures      ${summary.failures}`,
    `    cost (USD)    ${summary.costUsd}`,
    `    input tokens  ${summary.tokens.input}`,
    `    output tokens ${summary.tokens.output}`,
    `    cache read    ${summary.tokens.cacheRead}`,
    `    reasoning     ${summary.tokens.reasoning}`,
    `    avg latency   ${Math.round(summary.avgLatencyMs)} ms`,
  ].join("\n") + "\n",
)

const bySource = new Map<string, number>()
for (const event of mik.usage.query({ limit: 1000 }).events) {
  bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1)
}
process.stdout.write(`    by source     ${[...bySource].map(([source, count]) => `${source}=${count}`).join(" ")}\n`)
if (warnings.length > 0) process.stdout.write(`    warnings      ${warnings.slice(0, 3).join(" | ")}\n`)

mik.close()
process.stdout.write("\nOK\n")
