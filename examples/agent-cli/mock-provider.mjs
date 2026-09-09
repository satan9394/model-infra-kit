// A tiny OpenAI-compatible mock with tool-calling support, for examples/agent-cli.
//
// Offline by construction: it binds 127.0.0.1 only and never makes an outbound
// request. It exists so the agent-cli skeleton can be exercised — including one
// real tool-calling round trip — without a key or a network.
//
//   node examples/agent-cli/mock-provider.mjs [--port 3221]
//
// Routes:
//   GET  /v1/models                 → one model, so `models.refresh()` works
//   POST /v1/chat/completions       → tool call when tools are offered and no
//                                     tool result is in the messages yet, text otherwise
//
// The model id it answers as is a **real** one (`deepseek-chat`), so the price
// archive bundled with llm-pricing can price the call while offline — that is
// what makes `stats` show a non-zero cost with no network access.
import { createServer } from "node:http"

const HOST = "127.0.0.1"
const portIndex = process.argv.indexOf("--port")
const PORT = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.MOCK_PORT ?? "3221")
const MODEL = process.env.MOCK_MODEL ?? "deepseek-chat"

/** Token counts reported by every response; large enough to price visibly. */
const USAGE = { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 }

const TOOL_NAME = "get_time"
const TOOL_ARGS = JSON.stringify({ timezone: "UTC" })

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

function lastToolResult(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === "tool") {
      return typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    }
  }
  return null
}

function answerText(prompt, toolResult) {
  const asked = typeof prompt === "string" ? prompt.slice(0, 60) : "your question"
  if (toolResult) {
    let iso = toolResult
    try {
      iso = JSON.parse(toolResult).iso ?? toolResult
    } catch {
      // Keep the raw tool output.
    }
    return `The clock says ${iso}. (mock answer about "${asked}", no network)`
  }
  return `Mock answer to "${asked}": this reply came from a local mock provider.`
}

function sseHead(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
}

function chunk(id, created, model, delta, finishReason, usage) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null, logprobs: null }],
    ...(usage ? { usage } : {}),
  })}\n\n`
}

/** Streams a tool call the way a real OpenAI-compatible provider does. */
function streamToolCall(res, id, created, model) {
  sseHead(res)
  res.write(
    chunk(
      id,
      created,
      model,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: TOOL_NAME, arguments: "" } }],
      },
      null,
    ),
  )
  // Arguments arrive in fragments; the SDK concatenates them per `index`.
  for (const piece of [TOOL_ARGS.slice(0, 8), TOOL_ARGS.slice(8)]) {
    res.write(chunk(id, created, model, { tool_calls: [{ index: 0, function: { arguments: piece } }] }, null))
  }
  res.write(chunk(id, created, model, {}, "tool_calls", USAGE))
  res.write("data: [DONE]\n\n")
  res.end()
}

function streamText(res, id, created, model, text) {
  sseHead(res)
  res.write(chunk(id, created, model, { role: "assistant" }, null))
  for (const piece of text.match(/.{1,10}/gu) ?? []) res.write(chunk(id, created, model, { content: piece }, null))
  res.write(chunk(id, created, model, {}, "stop", USAGE))
  res.write("data: [DONE]\n\n")
  res.end()
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`)
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`)

    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      json(res, 200, {
        object: "list",
        data: [{ id: MODEL, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "mock" }],
      })
      return
    }

    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      let body = {}
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        // An unparsable body is treated as an empty request.
      }
      const model = typeof body.model === "string" ? body.model : MODEL
      const id = `chatcmpl-mock-${Date.now().toString(36)}`
      const created = Math.floor(Date.now() / 1000)
      const offersTools = Array.isArray(body.tools) && body.tools.length > 0
      const toolResult = lastToolResult(body.messages)
      const prompt = Array.isArray(body.messages)
        ? [...body.messages].reverse().find((message) => message && message.role === "user")?.content
        : ""
      const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? "")
      // Tool call only when the question is actually about the time: that keeps
      // the mock honest (one tool round trip, then plain answers).
      const wantsToolCall = offersTools && toolResult === null && /\b(time|clock|hour)\b/i.test(promptText)

      if (body.stream === true) {
        if (wantsToolCall) streamToolCall(res, id, created, model)
        else streamText(res, id, created, model, answerText(prompt, toolResult))
        return
      }

      if (wantsToolCall) {
        json(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_mock_1", type: "function", function: { name: TOOL_NAME, arguments: TOOL_ARGS } },
                ],
              },
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
          usage: USAGE,
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
            message: { role: "assistant", content: answerText(prompt, toolResult) },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: USAGE,
      })
      return
    }

    json(res, 404, { error: { message: `no mock route for ${req.method} ${url.pathname}`, type: "invalid_request_error" } })
  })().catch((error) => {
    json(res, 500, { error: { message: String(error) } })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`mock OpenAI-compatible provider on http://${HOST}:${PORT}/v1`)
  console.log(`  model: ${MODEL} (a real id, so the offline price archive can price it)`)
  console.log(`  tool:  ${TOOL_NAME} (streaming tool_calls supported)`)
})
