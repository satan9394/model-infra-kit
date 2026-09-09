/**
 * A local OpenAI-compatible provider used by the e2e run.
 *
 * It is deliberately dumb and fully deterministic: no network, fixed token
 * counts, fixed replies. Everything the acceptance scenarios need is here —
 * `GET /v1/models`, non-streaming chat completions, SSE streaming and tool
 * calls — so the whole suite can prove metering without a real provider.
 *
 * Token counts mirror the numbers recorded in `docs/verified-facts.md` §1 so the
 * AI SDK's usage mapping is exercised the same way a real provider would.
 */
import { createServer } from "node:http"

const PROMPT_TOKENS = 1200
const COMPLETION_TOKENS = 300
const CACHED_TOKENS = 800
const REASONING_TOKENS = 64

export const MOCK_MODELS = [
  { id: "mock-mini", name: "Mock Mini", context_length: 128_000, max_output_tokens: 4_096 },
  { id: "mock-tool", name: "Mock Tool", context_length: 64_000, max_output_tokens: 2_048 },
]

function usage() {
  return {
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
    prompt_tokens_details: { cached_tokens: CACHED_TOKENS },
    completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

/** The last message decides what the model "answers". */
function lastMessage(messages) {
  return Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1] : {}
}

/**
 * The mock decides from the conversation alone whether it answers with a tool
 * call. The HTTP proxy surface does not forward a `tools` array, so keying off
 * the request body's tools would make a tool call impossible there; the message
 * text is what a real provider would also see.
 */
function wantsTool(messages) {
  const last = lastMessage(messages)
  if (last?.role === "tool") return false
  const text = JSON.stringify(messages ?? []).toLowerCase()
  return text.includes("weather") || text.includes("tool")
}

function toolCallFrame(model) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_mock_1",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "Beijing" }) },
      },
    ],
  }
}

function textReply(messages) {
  const last = lastMessage(messages)
  if (last?.role === "tool") return "The weather in Beijing is 21°C and clear."
  return "Mock reply: the local provider answered without touching the network."
}

/**
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<{ url: string, port: number, calls: Array<object>, close: () => Promise<void> }>}
 */
export async function startMockProvider(options = {}) {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const calls = []

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${host}`)
      const method = (req.method ?? "GET").toUpperCase()
      const body = method === "POST" ? await readBody(req) : ""
      let parsed = null
      if (body) {
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
      }
      calls.push({ method, path: url.pathname, model: parsed?.model ?? null, stream: parsed?.stream === true })

      if (method === "GET" && url.pathname === "/v1/models") {
        json(res, 200, { object: "list", data: MOCK_MODELS })
        return
      }

      if (method === "POST" && url.pathname === "/v1/chat/completions") {
        if (!parsed || !Array.isArray(parsed.messages)) {
          json(res, 400, { error: { message: "messages is required", type: "invalid_request_error" } })
          return
        }
        const model = typeof parsed.model === "string" && parsed.model ? parsed.model : "mock-mini"
        const id = `chatcmpl-mock-${calls.length}`
        const created = Math.floor(Date.now() / 1000)
        const useTool = wantsTool(parsed.messages)

        if (parsed.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
          const frame = (delta, finish, withUsage) => {
            const chunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
            }
            if (withUsage) chunk.usage = usage()
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
          frame({ role: "assistant", content: "" }, null, false)
          if (useTool) {
            frame({ tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, null, false)
            frame({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Beijing"}' } }] }, null, false)
            frame({}, "tool_calls", true)
          } else {
            for (const piece of ["Mock ", "streaming ", "reply ", "from ", "the local provider."]) {
              frame({ content: piece }, null, false)
            }
            frame({}, "stop", true)
          }
          res.write("data: [DONE]\n\n")
          res.end()
          return
        }

        if (useTool) {
          json(res, 200, {
            id,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message: toolCallFrame(model), finish_reason: "tool_calls", logprobs: null }],
            usage: usage(),
          })
          return
        }

        json(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: textReply(parsed.messages) },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: usage(),
        })
        return
      }

      json(res, 404, { error: { message: `no route for ${method} ${url.pathname}`, type: "invalid_request_error" } })
    })()
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.once("listening", resolve)
    server.listen(port, host)
  })

  const address = server.address()
  const boundPort = typeof address === "object" && address ? address.port : port

  return {
    url: `http://${host}:${boundPort}/v1`,
    port: boundPort,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** `node scripts/e2e/mock-provider.mjs` starts one on a random port and waits. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const mock = await startMockProvider()
  process.stdout.write(`mock provider listening on ${mock.url}\n`)
}
