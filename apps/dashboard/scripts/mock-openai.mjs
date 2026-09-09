// A minimal OpenAI-compatible mock, for exercising the dashboard end to end.
//
// It exists so that two things can be verified without a real API key:
//   1. 「测试连接」/「刷新模型」 on the /providers page (GET /v1/models), and
//   2. a real metered call: POST /v1/chat/completions through `mik serve`, which
//      records a usage event and pushes `usage.recorded` to /api/events.
//
// Usage:
//   node apps/dashboard/scripts/mock-openai.mjs            # 127.0.0.1:3212
//   node apps/dashboard/scripts/mock-openai.mjs --port 3213
//
// The seeded provider `mock-gateway` points at http://127.0.0.1:3212/v1.
import { createServer } from "node:http"

const args = process.argv.slice(2)
const portArg = args.indexOf("--port")
const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.MOCK_PORT ?? "3212")
const host = process.env.MOCK_HOST ?? "127.0.0.1"

const MODELS = [
  { id: "mock-chat-pro", name: "Mock Chat Pro", context_length: 128000, max_output_tokens: 8192 },
  { id: "mock-chat-lite", name: "Mock Chat Lite", context_length: 32768, max_output_tokens: 4096 },
  { id: "mock-reasoner", name: "Mock Reasoner", context_length: 65536, max_output_tokens: 16384 },
  { id: "mock-vision", name: "Mock Vision", context_length: 200000, max_output_tokens: 8192 },
]

const USAGE = { prompt_tokens: 1234, completion_tokens: 321, total_tokens: 1555 }
const TEXT = "这是 mock 供应商返回的一段固定文本，用于验证 mik 的计量与看板。"

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

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`)
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`)

    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      json(res, 200, { object: "list", data: MODELS.map((model) => ({ ...model, object: "model", owned_by: "mock" })) })
      return
    }

    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const raw = await readBody(req)
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        // Treat an unparsable body as an empty request.
      }
      const model = typeof body.model === "string" ? body.model : "mock-chat-pro"
      const id = `chatcmpl-mock-${Date.now().toString(36)}`
      const created = Math.floor(Date.now() / 1000)

      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const frame = (delta, finish, usage) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
            ...(usage ? { usage } : {}),
          })}\n\n`
        res.write(frame({ role: "assistant" }, null))
        for (const piece of TEXT.match(/.{1,12}/gu) ?? []) res.write(frame({ content: piece }, null))
        res.write(frame({}, "stop", USAGE))
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }

      json(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: TEXT }, finish_reason: "stop", logprobs: null }],
        usage: USAGE,
      })
      return
    }

    json(res, 404, { error: { message: `no mock route for ${req.method} ${url.pathname}`, type: "invalid_request_error" } })
  })().catch((error) => {
    json(res, 500, { error: { message: String(error) } })
  })
})

server.listen(port, host, () => {
  console.log(`mock OpenAI-compatible server on http://${host}:${port}/v1`)
  console.log(`  供应商配置: baseUrl=http://${host}:${port}/v1 protocol=openai-compatible（不需要密钥）`)
})
