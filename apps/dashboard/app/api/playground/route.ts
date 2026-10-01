import { NextResponse, type NextRequest } from "next/server"
import { mikServerToken, mikServerUrl } from "@/lib/config"
import { redact, redactPlaygroundStream } from "@/lib/playground"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  // A cookie-authenticated proxy must not accept cross-origin billed requests.
  if (request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({ error: "Origin rejected" }, { status: 403 })
  const raw = await request.text()
  if (raw.length > 10_000) return NextResponse.json({ error: "Prompt too long" }, { status: 400 })
  let body: { model?: unknown; prompt?: unknown; traceId?: unknown }
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  if (!body || typeof body.model !== "string" || !body.model.includes(":") || body.model.length > 256 || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 8000 || typeof body.traceId !== "string" || !/^playground-[a-f0-9-]{36}$/.test(body.traceId)) return NextResponse.json({ error: "Invalid prompt or model" }, { status: 400 })
  const token = mikServerToken()
  try {
    const upstream = await fetch(`${mikServerUrl()}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model: body.model, messages: [{ role: "user", content: body.prompt.trim() }], stream: true, max_tokens: 128, trace_id: body.traceId }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]), cache: "no-store",
    })
    if (!upstream.ok) return new NextResponse(redact(await upstream.text()), { status: upstream.status })
    if (!upstream.body) return NextResponse.json({ error: "Empty upstream response" }, { status: 502 })
    return new NextResponse(redactPlaygroundStream(upstream.body), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
  } catch (error) {
    return NextResponse.json({ error: redact(error instanceof Error ? error.message : String(error)) }, { status: 502 })
  }
}
