import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { connectionSnippet, FRAMEWORKS, publicBaseUrl } from "../lib/connect.ts"
import { readPlaygroundStream, redactPlaygroundStream, usdToMicros } from "../lib/playground.ts"

test("all five snippets use the runtime endpoint, namespaced model and gateway environment reference", () => {
  const base = publicBaseUrl("https://example.test:4321/prefix/")
  assert.equal(base, "https://example.test:4321/prefix/v1")
  assert.equal(publicBaseUrl("https://user:private@example.test/?api_key=hidden#secret"), "https://example.test/v1")
  for (const framework of FRAMEWORKS) {
    const code = connectionSnippet(framework, base, "local:namespace/model")
    assert.ok(code.includes(base) && code.includes("local:namespace/model") && code.includes("MIK_SERVER_TOKEN"), framework)
    if (framework === "ai" || framework === "openai-node") {
      const ast = ts.createSourceFile("snippet.ts", code, ts.ScriptTarget.Latest, true)
      assert.equal((ast as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length, 0)
    }
  }
  assert.match(connectionSnippet("ai", base, "p:m"), /gateway\.chat\(/)
  assert.match(connectionSnippet("curl", base, "p:quote'$(command)"), /'"'"'/)
  assert.match(connectionSnippet("openai-python", base, 'p:a"b'), /p:a\\"b/)
  assert.throws(() => publicBaseUrl("file:///private"))
})

function stream(parts: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close() } })
}
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`

test("SSE handles split transport chunks, multiple frames, usage and first displayed text timing", async () => {
  const input = frame({ choices: [{ delta: { role: "assistant" } }] }) + frame({ choices: [{ delta: { content: "Hello " } }] }) + frame({ choices: [{ delta: { content: "world" } }], usage: { prompt_tokens: 5, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } } }) + "data: [DONE]\r\n\r\n"
  const text: string[] = []
  let time = 10
  const result = await readPlaygroundStream(new Response(stream([input.slice(0, 7), input.slice(7, 63), input.slice(63)])), (value) => text.push(value), () => time += 10, 0)
  assert.equal(result.text, "Hello world")
  assert.equal(result.ttftMs, 20)
  assert.deepEqual([result.input, result.output, result.reasoning], [5, 2, 0])
  assert.equal(text.at(-1), "Hello world")
})

test("missing usage and TTFT remain absent, failed and truncated streams cannot claim completion", async () => {
  const result = await readPlaygroundStream(new Response(stream(["data: [DONE]\n\n"])), () => {})
  assert.equal(result.ttftMs, null)
  assert.deepEqual([result.input, result.output, result.reasoning], [null, null, null])
  await assert.rejects(readPlaygroundStream(new Response(stream([frame({ error: { message: "api_key=secret123" } })])), () => {}), /REDACTED/)
  await assert.rejects(readPlaygroundStream(new Response(stream([frame({ choices: [{ delta: { content: "partial" } }] })])), () => {}), /before completion/)
  await assert.rejects(readPlaygroundStream(new Response("unauthorized", { status: 401 }), () => {}), /unauthorized/)
})

test("browser stream redacts credentials split across upstream frames and removes arbitrary metadata", async () => {
  const input = frame({ choices: [{ delta: { content: "Hello sk-" } }], api_key: "secret" }) + frame({ choices: [{ delta: { content: "secret123! " } }] }) + frame({ usage: { prompt_tokens: 1, completion_tokens: 2, secret: "hidden", completion_tokens_details: { reasoning_tokens: 0 } } }) + "data: [DONE]\n\n"
  const response = new Response(redactPlaygroundStream(stream([input.slice(0, 45), input.slice(45)])))
  const text = await response.text()
  assert.doesNotMatch(text, /secret123|api_key|hidden/)
  assert.match(text, /sk-\*\*\*\*/)
  const basic = frame({ choices: [{ delta: { content: "Authorization: " } }] }) + frame({ choices: [{ delta: { content: "Basic YWJjZGVm " } }] }) + "data: [DONE]\n\n"
  assert.doesNotMatch(await new Response(redactPlaygroundStream(stream([basic]))).text(), /YWJjZGVm/)
})

test("recorded USD converts at the integer micro boundary without float accumulation", () => {
  assert.equal(usdToMicros(0.000001), 1)
  assert.equal(usdToMicros(0.000654), 654)
  assert.equal(usdToMicros(1e-7), 0)
  assert.equal(usdToMicros(1.234567), 1_234_567)
  assert.throws(() => usdToMicros(-1))
  assert.throws(() => usdToMicros(Infinity))
  assert.throws(() => usdToMicros(Number.MAX_SAFE_INTEGER))
})

test("Playground keeps the gateway token server-side, records by unique trace and uses a standard billed endpoint", () => {
  const server = readFileSync(new URL("../app/api/playground/route.ts", import.meta.url), "utf8")
  const drawer = readFileSync(new URL("../components/playground-drawer.tsx", import.meta.url), "utf8")
  assert.match(server, /\/v1\/chat\/completions/)
  assert.match(server, /request\.headers\.get\("origin"\)/)
  assert.match(server, /redactPlaygroundStream/)
  assert.match(server, /max_tokens: 128/)
  assert.doesNotMatch(drawer, /mikServerToken|localStorage|apiKey/)
  assert.match(drawer, /crypto\.randomUUID/)
  assert.match(drawer, /usage\/logs\?traceId=/)
  assert.match(drawer, /cost\.source === "missing"/)
})
