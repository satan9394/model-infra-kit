import { redact } from "../../../packages/mik/src/util/redact.ts"
export { redact }

/** Only redacted text and numeric usage cross the browser boundary. Hold unfinished
 * words so a credential split across upstream frames cannot escape redaction. */
export function redactPlaygroundStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  let buffer = "", pending = ""
  const numericUsage = (usage: Record<string, unknown>) => {
    const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    return { prompt_tokens: count(usage.prompt_tokens), completion_tokens: count(usage.completion_tokens), completion_tokens_details: { reasoning_tokens: count((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens) } }
  }
  function emit(raw: string, controller: TransformStreamDefaultController<Uint8Array>) {
    const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`))
    const flushText = (final: boolean) => {
      const words = [...pending.matchAll(/\S+/g)]
      // Keep scheme + credential together (Authorization: Basic … / Bearer …).
      const end = final ? pending.length : words.length > 3 ? words[words.length - 3]!.index : 0
      if (end > 0) { send({ choices: [{ delta: { content: redact(pending.slice(0, end)) } }] }); pending = pending.slice(end) }
    }
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    if (!data) return
    if (data === "[DONE]") { flushText(true); send(data); return }
    const value = JSON.parse(data)
    if (value.error) { pending = ""; send({ error: { message: redact(String(value.error.message ?? "Stream failed")) } }); return }
    const text = value.choices?.[0]?.delta?.content
    if (typeof text === "string") { pending += text; flushText(false) }
    if (value.usage) { flushText(true); send({ usage: numericUsage(value.usage) }) }
  }
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) { const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); emit(frame, controller) }
    },
    flush(controller) { buffer += decoder.decode(); if (buffer.trim()) emit(buffer, controller) },
  }))
}

/** Convert the gateway's decimal USD representation once; never accumulate floats. */
export function usdToMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid cost")
  const [coefficient = "0", exponent = "0"] = String(value).toLowerCase().split("e")
  const [whole = "0", fraction = ""] = coefficient.split(".")
  const power = Number(exponent) - fraction.length + 6
  const digits = BigInt(whole + fraction)
  const divisor = power < 0 ? 10n ** BigInt(-power) : 1n
  const micros = power >= 0 ? digits * 10n ** BigInt(power) : (digits + divisor / 2n) / divisor
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Cost exceeds safe micro-USD precision")
  return Number(micros)
}

export interface PlaygroundStreamResult {
  text: string
  ttftMs: number | null
  durationMs: number
  input: number | null
  output: number | null
  reasoning: number | null
}

/** SSE frame boundaries, rather than transport chunks, determine JSON parsing. */
export async function readPlaygroundStream(response: Response, onText: (text: string) => void, now = () => performance.now(), startedAt = now()): Promise<PlaygroundStreamResult> {
  if (!response.ok) throw new Error(redact((await response.text()).slice(0, 500) || `HTTP ${response.status}`))
  if (!response.body) throw new Error("Empty stream")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = "", text = "", ttftMs: number | null = null, done = false
  let input: number | null = null, output: number | null = null, reasoning: number | null = null
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
  function frame(raw: string) {
    const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    if (!data) return
    if (data === "[DONE]") { done = true; return }
    const value = JSON.parse(data)
    if (value.error) throw new Error(redact(String(value.error.message ?? "Stream failed")))
    const delta = value.choices?.[0]?.delta?.content
    if (typeof delta === "string" && delta.length) {
      ttftMs ??= Math.round(now() - startedAt)
      text += delta
      onText(redact(text))
    }
    if (value.usage) {
      input = count(value.usage.prompt_tokens)
      output = count(value.usage.completion_tokens)
      reasoning = count(value.usage.completion_tokens_details?.reasoning_tokens)
    }
  }
  try {
    while (!done) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        frame(raw)
      }
      if (chunk.done) break
    }
    if (!done) throw new Error("Stream ended before completion")
    return { text: redact(text), ttftMs, durationMs: Math.round(now() - startedAt), input, output, reasoning }
  } finally { await reader.cancel(); reader.releaseLock() }
}
