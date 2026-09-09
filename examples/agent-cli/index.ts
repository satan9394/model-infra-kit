/**
 * examples/agent-cli — a minimal, actually runnable Agent CLI skeleton.
 *
 * This is the shape a host like Claude Code would use: a thin command layer on
 * top of `model-infra-kit`. Everything below goes through the **public** API
 * only (`ModelInfra.init`, `providers`, `stream`, `usage`), so it works the same
 * way against the workspace source and against the published npm package.
 *
 *   model add <id> --preset <p> [--base-url <url>] [--api-key-ref <ref>]
 *   model list
 *   model use <provider:model>
 *   chat "<prompt>"
 *   stats
 *
 * Global flags: `--db <path>`, `--app-id <id>`, `--online-pricing`, `--help`.
 *
 * Run it from the repository root (no build needed):
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     --import ./scripts/e2e/loader.mjs examples/agent-cli/index.ts model list
 */
import { parseArgs } from "node:util"
import { jsonSchema, tool } from "ai"
import { ModelInfra, isModelInfraError } from "model-infra-kit"
import type { CostInfo, ProviderRecord, TokenUsage, UsageEvent } from "model-infra-kit"

/** `env:VAR` / `file:path` / `keychain:service` — a reference, never a plaintext key. */
const KEY_REF_PATTERN = /^(env|file|keychain):.+/i

/** Flags accepted anywhere on the command line; the command layer validates what it needs. */
const OPTIONS = {
  help: { type: "boolean", short: "h" },
  db: { type: "string" },
  "app-id": { type: "string" },
  preset: { type: "string" },
  "base-url": { type: "string" },
  "api-key-ref": { type: "string" },
  name: { type: "string" },
  model: { type: "string" },
  session: { type: "string" },
  "online-pricing": { type: "boolean" },
} as const

const HELP = `agent-cli — a minimal Agent CLI on top of model-infra-kit

USAGE
  agent-cli model add <id> --preset <presetId> [--base-url <url>] [--api-key-ref <ref>] [--name <label>]
  agent-cli model list
  agent-cli model use <provider:model>
  agent-cli chat "<prompt>" [--model <provider:model>] [--session <id>]
  agent-cli stats

GLOBAL OPTIONS
  --db <path>        SQLite database (default: ./agent-cli.db)
  --app-id <id>      Owning app id stamped on every usage row (default: agent-cli)
  --online-pricing   Let the price catalogue load from the network (default: offline)
  -h, --help         Show this help

EXAMPLES
  agent-cli model add local --preset custom-openai-compatible --base-url http://127.0.0.1:3221/v1
  agent-cli model use local:deepseek-chat
  agent-cli chat "what time is it?"
  agent-cli stats
`

/** A bad invocation (exit 2), as opposed to a runtime failure (exit 1). */
class UsageError extends Error {}

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
}

function err(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`)
}

function requireArg(positionals: string[], index: number, label: string): string {
  const value = positionals[index]
  if (!value || value.startsWith("-")) throw new UsageError(`Missing required argument ${label}.`)
  return value
}

function flag(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function flagOn(values: Record<string, unknown>, key: string): boolean {
  return values[key] === true
}

/** Column layout without pulling in a dependency — the host owns its own output. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  )
  const line = (cells: string[]): string => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ")
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n")
}

function keyValues(pairs: [string, string][]): string {
  const width = Math.max(...pairs.map(([key]) => key.length))
  return pairs.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`).join("\n")
}

function money(usd: number): string {
  return `$${usd.toFixed(6)}`
}

function tokens(usage: TokenUsage): string {
  return `in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} reasoning=${usage.reasoning}`
}

function costLine(cost: CostInfo): string {
  return `${money(cost.usd)} (basis=${cost.basis} source=${cost.source}${cost.pricingModel ? ` model=${cost.pricingModel}` : ""})`
}

/**
 * The offline switch: a `fetch` that refuses. The bundled price archive still
 * prices requests, so an offline run shows a real, non-zero cost.
 */
const offlineFetch: typeof globalThis.fetch = async (input) => {
  throw new Error(`offline: refusing to fetch ${typeof input === "string" ? input : "the network"}`)
}

interface OpenOptions {
  db: string
  appId: string
  online: boolean
}

/**
 * One place where the host opens mik. A CLI would call this once per process
 * (or keep the instance for the life of a long-running session).
 *
 * `syncCatalog: false` keeps the skeleton offline: no provider is probed behind
 * the user's back. A real host would leave it at the default (`true`).
 */
async function open(options: OpenOptions): Promise<ModelInfra> {
  return ModelInfra.init({
    appId: options.appId,
    db: options.db,
    syncCatalog: false,
    pricingFetch: options.online ? undefined : offlineFetch,
    onWarn: (message) => err(`[mik] ${message}`),
  })
}

function providerRows(records: ProviderRecord[], defaultRef: string | null): string[][] {
  const defaultProvider = defaultRef?.includes(":") ? defaultRef.slice(0, defaultRef.indexOf(":")) : null
  return records.map((record) => [
    record.id,
    record.name,
    record.protocol ?? "-",
    record.baseUrl ?? "-",
    record.apiKeyRef ?? "-",
    record.enabled ? "yes" : "no",
    record.id === defaultProvider ? "yes" : "",
  ])
}

async function runModelAdd(positionals: string[], values: Record<string, unknown>, options: OpenOptions): Promise<number> {
  const id = requireArg(positionals, 2, "<id>")
  const presetId = flag(values, "preset")
  const baseUrl = flag(values, "base-url")
  const apiKeyRef = flag(values, "api-key-ref")
  const name = flag(values, "name")

  if (!presetId && !baseUrl) {
    throw new UsageError("`model add` needs --preset <presetId> (and usually --base-url for a local endpoint).")
  }
  if (apiKeyRef && !KEY_REF_PATTERN.test(apiKeyRef)) {
    throw new UsageError(
      `--api-key-ref must be a reference (env:VAR, file:path, keychain:service), got "${apiKeyRef}". ` +
        "A plaintext key is never stored.",
    )
  }

  const mik = await open(options)
  try {
    const record = mik.providers.add({ id, presetId, baseUrl, apiKeyRef, name })
    out(`Added provider "${record.id}".`)
    out("")
    out(table(
      ["PROVIDER", "NAME", "PROTOCOL", "BASE URL", "KEY REF", "ENABLED"],
      [[record.id, record.name, record.protocol ?? "-", record.baseUrl ?? "-", record.apiKeyRef ?? "-", record.enabled ? "yes" : "no"]],
    ))
    out("")
    out(`Next: agent-cli model use ${record.id}:<modelId>`)
    return 0
  } finally {
    await mik.close()
  }
}

async function runModelList(options: OpenOptions): Promise<number> {
  const mik = await open(options)
  try {
    const records = mik.providers.list()
    const defaultRef = mik.providers.defaultModel()
    if (records.length === 0) {
      out("No providers configured.")
      out("")
      out('Add one with: agent-cli model add local --preset custom-openai-compatible --base-url <url>')
      return 0
    }
    out(table(["PROVIDER", "NAME", "PROTOCOL", "BASE URL", "KEY REF", "ENABLED", "DEFAULT"], providerRows(records, defaultRef)))
    out("")
    out(`Default model: ${defaultRef ?? "(not set)"}`)
    out(`App id: ${mik.appId}   Database: ${options.db}`)

    const catalogue = mik.models.list()
    out("")
    if (catalogue.length === 0) {
      out("Model catalogue: empty (this skeleton runs with syncCatalog: false).")
      out("Refresh it with: node packages/mik/dist/cli.mjs models --provider <id> --refresh")
    } else {
      out(table(
        ["MODEL REF", "SOURCE", "CONTEXT", "TOOL CALL"],
        catalogue.map((model) => [
          model.ref,
          model.source,
          model.contextWindow === undefined ? "-" : String(model.contextWindow),
          model.capabilities.toolCall ? "yes" : "no",
        ]),
      ))
    }
    return 0
  } finally {
    await mik.close()
  }
}

async function runModelUse(positionals: string[], options: OpenOptions): Promise<number> {
  const ref = requireArg(positionals, 2, "<provider:model>")
  const mik = await open(options)
  try {
    mik.providers.setDefaultModel(ref)
    out(`Default model: ${mik.providers.defaultModel()}`)
    out("`chat` without --model now routes here.")
    return 0
  } finally {
    await mik.close()
  }
}

async function runModel(positionals: string[], values: Record<string, unknown>, options: OpenOptions): Promise<number> {
  const action = positionals[1]
  switch (action) {
    case "add":
      return runModelAdd(positionals, values, options)
    case "list":
      return runModelList(options)
    case "use":
      return runModelUse(positionals, options)
    default:
      throw new UsageError(`Unknown "model" action "${action ?? ""}". Expected add | list | use.`)
  }
}

/**
 * One streaming turn with exactly one tool available.
 *
 * The tool loop itself lives in mik (AI SDK `stopWhen: stepCountIs(5)`), so the
 * host only has to consume `StreamEvent`s: text deltas, tool-call completions,
 * then `usage` + `finish`. Nothing here touches the network — `get_time` reads
 * the system clock.
 */
async function runChat(positionals: string[], values: Record<string, unknown>, options: OpenOptions): Promise<number> {
  const prompt = requireArg(positionals, 1, "<prompt>")
  const model = flag(values, "model")
  const sessionId = flag(values, "session") ?? `chat-${Date.now().toString(36)}`

  const toolRuns: { input: unknown; output: unknown }[] = []
  const tools = {
    get_time: tool({
      description: "Return the current time. Local clock only, no network.",
      inputSchema: jsonSchema<{ timezone?: string }>({
        type: "object",
        properties: { timezone: { type: "string", description: "IANA time zone, e.g. UTC" } },
        required: [],
        additionalProperties: false,
      }),
      execute: async (input: { timezone?: string }) => {
        const output = { timezone: input.timezone ?? "UTC", iso: new Date().toISOString() }
        toolRuns.push({ input, output })
        return output
      },
    }),
  }

  const mik = await open(options)
  try {
    let usage: TokenUsage | undefined
    let cost: CostInfo | undefined
    let finishReason = "-"
    let steps = 0
    let actualModel = "-"
    let failure: { code: string; message: string } | undefined
    let text = ""

    out(`session ${sessionId}${model ? ` · model ${model}` : ""}`)
    out("")
    for await (const event of mik.stream({
      model,
      messages: [{ role: "user", content: prompt }],
      system: "You are a terse CLI agent. Call get_time when the user asks for the time.",
      tools,
      sessionId,
      tags: { example: "agent-cli", command: "chat" },
    })) {
      switch (event.type) {
        case "text_delta":
          text += event.text
          process.stdout.write(event.text)
          break
        case "tool_call_complete":
          out("")
          out(`[tool] ${event.call.name}(${JSON.stringify(event.call.input)})`)
          break
        case "usage":
          usage = event.usage
          cost = event.cost
          break
        case "finish":
          finishReason = event.response.finishReason
          steps = event.response.steps ?? 1
          actualModel = event.response.model.actual
          break
        case "error":
          failure = event.error
          break
        default:
          break
      }
    }
    out("")
    out("")
    for (const run of toolRuns) out(`[tool result] ${JSON.stringify(run.output)}`)
    if (failure) {
      // A stream failure arrives as an `error` event, not an exception.
      err(`error: ${failure.code}: ${failure.message}`)
      return 1
    }
    out(table(
      ["FIELD", "VALUE"],
      [
        ["text", JSON.stringify(text.slice(0, 120))],
        ["model", actualModel],
        ["finish", finishReason],
        ["steps", String(steps)],
        ["tool calls", String(toolRuns.length)],
        ["usage", usage ? tokens(usage) : "-"],
        ["cost", cost ? costLine(cost) : "-"],
      ],
    ))
    return 0
  } finally {
    await mik.close()
  }
}

async function runStats(options: OpenOptions): Promise<number> {
  const mik = await open(options)
  try {
    const summary = mik.usage.summary()
    const page = mik.usage.query({ limit: 1000 })
    const bySource = new Map<string, number>()
    const byModel = new Map<string, number>()
    for (const event of page.events as UsageEvent[]) {
      bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1)
      byModel.set(event.modelActual, (byModel.get(event.modelActual) ?? 0) + 1)
    }
    const tally = (map: Map<string, number>): string =>
      map.size === 0 ? "-" : [...map].map(([key, count]) => `${key}=${count}`).join(" ")

    out(`app=${mik.appId}  db=${options.db}`)
    out("")
    out(keyValues([
      ["requests", String(summary.requests)],
      ["successes", String(summary.successes)],
      ["failures", String(summary.failures)],
      ["success rate", `${(summary.successRate * 100).toFixed(1)}%`],
      ["cost (USD)", money(summary.costUsd)],
      ["cost range", `${money(summary.costLowUsd)} – ${money(summary.costHighUsd)}`],
      ["input tokens", String(summary.tokens.input)],
      ["output tokens", String(summary.tokens.output)],
      ["cache read", String(summary.tokens.cacheRead)],
      ["cache write", String(summary.tokens.cacheWrite)],
      ["reasoning", String(summary.tokens.reasoning)],
      ["cache hit rate", `${(summary.cacheHitRate * 100).toFixed(1)}%`],
      ["avg latency", `${Math.round(summary.avgLatencyMs)} ms`],
      ["first token", `${Math.round(summary.firstTokenMs)} ms`],
    ]))
    out("")
    out(`usage rows in db: ${page.total} (listed ${page.events.length})`)
    out(`by source: ${tally(bySource)}`)
    out(`by model:  ${tally(byModel)}`)
    return 0
  } finally {
    await mik.close()
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  const command = positionals[0]

  if (flagOn(values, "help") || command === undefined || command === "help") {
    out(HELP)
    return 0
  }

  const options: OpenOptions = {
    db: flag(values, "db") ?? process.env.MIK_DB ?? "agent-cli.db",
    appId: flag(values, "app-id") ?? process.env.MIK_APP_ID ?? "agent-cli",
    online: flagOn(values, "online-pricing"),
  }

  switch (command) {
    case "model":
      return runModel(positionals, values, options)
    case "chat":
      return runChat(positionals, values, options)
    case "stats":
      return runStats(options)
    default:
      throw new UsageError(`Unknown command "${command}". Expected model | chat | stats | help.`)
  }
}

try {
  process.exitCode = await main(process.argv.slice(2).filter((argument) => argument !== "--"))
} catch (error) {
  if (error instanceof UsageError) {
    err(`error: ${error.message}`)
    err("")
    err(HELP)
    process.exitCode = 2
  } else if (isModelInfraError(error)) {
    // Branch on `code`, never on the message text: messages are for humans and
    // may change between releases.
    err(`error: ${error.code} (retryable=${error.retryable}) ${error.message}`)
    process.exitCode = 1
  } else {
    err(`error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
