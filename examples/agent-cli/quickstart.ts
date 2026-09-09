/**
 * examples/agent-cli/quickstart.ts — the smallest complete host.
 *
 * This is the code block the guide (`docs/agent-cli-guide.md`) shows: init →
 * register a provider → generate → stream one turn with a tool → close. It is
 * runnable as-is against the local mock, so the snippet is never aspirational.
 *
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/e2e/loader.mjs examples/agent-cli/quickstart.ts
 */
import { jsonSchema, tool } from "ai"
import { ModelInfra, isModelInfraError } from "model-infra-kit"

const baseUrl = process.env.MIK_MOCK_BASE_URL ?? "http://127.0.0.1:3221/v1"

/** Offline: the bundled price archive still prices every call. */
const offlineFetch: typeof globalThis.fetch = async () => {
  throw new Error("offline: the price catalogue is not fetched")
}

const mik = await ModelInfra.init({
  appId: "quickstart-agent",
  db: ":memory:",
  syncCatalog: false,
  pricingFetch: offlineFetch,
  // First run seeds the provider; later runs skip it (seed is idempotent).
  providers: [{ id: "local", presetId: "custom-openai-compatible", baseUrl }],
  defaultModel: "local:deepseek-chat",
  onWarn: (message) => process.stderr.write(`[mik] ${message}\n`),
})

try {
  // 1. non-streaming, one shot
  const reply = await mik.generate({ messages: [{ role: "user", content: "Say hello." }] })
  console.log(`generate: ${reply.text}`)
  console.log(`  model=${reply.model.actual} usage=${JSON.stringify(reply.usage)} cost=$${reply.cost.usd} (${reply.cost.source})`)

  // 2. streaming with one tool; mik runs the tool loop (max 5 steps)
  process.stdout.write("stream: ")
  for await (const event of mik.stream({
    messages: [{ role: "user", content: "What time is it?" }],
    tools: {
      get_time: tool({
        description: "Current time from the local clock.",
        inputSchema: jsonSchema<{ timezone?: string }>({
          type: "object",
          properties: { timezone: { type: "string" } },
          additionalProperties: false,
        }),
        execute: async (input: { timezone?: string }) => ({ timezone: input.timezone ?? "UTC", iso: new Date().toISOString() }),
      }),
    },
    sessionId: "quickstart",
  })) {
    if (event.type === "text_delta") process.stdout.write(event.text)
    if (event.type === "tool_call_complete") process.stdout.write(`[${event.call.name}] `)
    if (event.type === "usage") console.log(`\n  cost=$${event.cost.usd} (${event.cost.source})`)
    if (event.type === "finish") console.log(`  steps=${event.response.steps ?? 1} usage=${JSON.stringify(event.response.usage)}`)
    // `stream()` reports failures as events; branch on the code, never the text.
    if (event.type === "error") throw Object.assign(new Error(event.error.message), { code: event.error.code })
  }

  console.log(`summary: ${JSON.stringify(mik.usage.summary())}`)
} catch (error) {
  if (isModelInfraError(error)) {
    console.error(`mik error ${error.code} (retryable=${error.retryable}): ${error.message}`)
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
} finally {
  // Always close: it waits for the background catalogue sync, then closes SQLite.
  await mik.close()
}
