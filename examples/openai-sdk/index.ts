/**
 * Example host: an existing codebase that already talks to the OpenAI SDK.
 *
 * `docs/SPEC.md` §2.2 — the "fetch adapter" surface. The point of this file is
 * how little it contains: the business code below is byte-for-byte what it was
 * before model-infra-kit existed. Only the client construction changed, and only
 * two options: `baseURL` and `fetch`.
 *
 *   const client = new OpenAI({ baseURL: mik.baseUrl, fetch: mik.fetch })
 *
 * Every call then flows through the hub: the provider is resolved from the
 * `provider:model` reference in the request body, the configured credential is
 * attached by the provider's protocol, and the provider's own `usage` is priced
 * and stored. The response the caller receives is the provider's response.
 *
 *   pnpm --filter @mik/example-openai-sdk start -- --model local:mock-mini
 */
import { parseArgs } from "node:util"
import OpenAI from "openai"
import { ModelInfra } from "model-infra-kit"

const offlineFetch: typeof globalThis.fetch = async () => {
  throw new Error("offline: the example does not fetch the price catalogue")
}

const { values } = parseArgs({
  // A `--` separator (as `pnpm start -- --flag` produces) is dropped: this
  // example takes no positional arguments.
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  options: {
    model: { type: "string" },
    db: { type: "string" },
    "app-id": { type: "string" },
    "base-url": { type: "string" },
    provider: { type: "string" },
    "online-pricing": { type: "boolean" },
  },
  allowPositionals: true,
  strict: true,
})

const db = values.db ?? process.env.MIK_DB ?? "example-openai-sdk.db"
const appId = values["app-id"] ?? process.env.MIK_APP_ID ?? "example-openai-sdk"
const baseUrl = values["base-url"] ?? process.env.MIK_EXAMPLE_BASE_URL
const providerId = values.provider ?? process.env.MIK_EXAMPLE_PROVIDER ?? "local"
const onlinePricing = values["online-pricing"] === true || process.env.MIK_EXAMPLE_ONLINE_PRICING === "1"

const mik = await ModelInfra.init({
  appId,
  db,
  cacheDir: process.env.MIK_CACHE_DIR,
  pricingFetch: onlinePricing ? undefined : offlineFetch,
  onWarn: () => {},
})

// Optional convenience for a standalone run: register the endpoint being used.
// A real host configures providers once (CLI or dashboard) and deletes this.
if (baseUrl && !mik.providers.get(providerId)) {
  mik.providers.add({ id: providerId, name: "Example local provider", protocol: "openai-compatible", baseUrl })
}

const model = values.model ?? process.env.MIK_EXAMPLE_MODEL ?? mik.providers.defaultModel()
if (!model) {
  process.stderr.write(
    "No model to call. Pass --model <provider:model> or set a default with mik.providers.setDefaultModel().\n",
  )
  mik.close()
  process.exit(2)
}

// ───────────────────────── the only two changed lines ─────────────────────────
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "managed-by-model-infra-kit",
  baseURL: mik.baseUrl,
  fetch: mik.fetch,
})
// ────────────────────────────── untouched business code ───────────────────────
const completion = await client.chat.completions.create({
  model,
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Explain why the sky is blue in one sentence." },
  ],
})

const answer = completion.choices[0]?.message?.content ?? ""
process.stdout.write(`answer: ${JSON.stringify(answer.slice(0, 120))}\n`)
process.stdout.write(`model:  ${completion.model}\n`)
process.stdout.write(`usage:  ${JSON.stringify(completion.usage)}\n`)

// ─────────────────────────── the metering proof ───────────────────────────────
const events = mik.usage.query({ limit: 10 }).events
const metered = events.filter((event) => event.source === "fetch")
const latest = metered[0]
process.stdout.write(`metered rows (source=fetch): ${metered.length}\n`)
if (latest) {
  process.stdout.write(
    `latest: ${latest.providerId}/${latest.modelActual} status=${latest.status} ` +
      `in=${latest.usage.input} out=${latest.usage.output} cache=${latest.usage.cacheRead} ` +
      `reasoning=${latest.usage.reasoning} cost=$${latest.cost.usd} source=${latest.cost.source} ` +
      `streaming=${latest.isStreaming}\n`,
  )
}
const summary = mik.usage.summary()
process.stdout.write(`summary: requests=${summary.requests} costUsd=${summary.costUsd} tokens=${JSON.stringify(summary.tokens)}\n`)

mik.close()
if (metered.length === 0) {
  process.stderr.write("FAIL: the call was not metered\n")
  process.exit(1)
}
process.stdout.write("OK\n")
