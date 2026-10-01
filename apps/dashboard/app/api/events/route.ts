import { getI18n } from "@/lib/i18n/server"
import { NextResponse, type NextRequest } from "next/server"
import { mikServerToken, mikServerUrl } from "@/lib/config"

/**
 * SSE passthrough of `GET /api/events` from `mik serve`.
 *
 * The browser subscribes to this route, which keeps the upstream URL and token
 * on the server and works even though the mik server ships with CORS disabled.
 * Frames are forwarded verbatim, so the client sees the original
 * `usage.recorded` / `catalog.updated` / `pricing.updated` event names.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest): Promise<Response> {
  const { t } = await getI18n()
  const target = `${mikServerUrl()}/api/events`
  const headers: Record<string, string> = { accept: "text/event-stream", "cache-control": "no-cache" }
  const token = mikServerToken()
  if (token) headers.authorization = `Bearer ${token}`

  let upstream: Response
  try {
    upstream = await fetch(target, {
      headers,
      cache: "no-store",
      // The browser closing the EventSource aborts this request, which in turn
      // tears down the upstream connection instead of leaking a mik SSE client.
      signal: request.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { error: { message: t("s371", mikServerUrl(), message), code: "MIK_UNREACHABLE" } },
      { status: 502 },
    )
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: { message: t("s372", upstream.status), code: "MIK_EVENTS_FAILED" } },
      { status: 502 },
    )
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Belt and braces for proxies that would otherwise buffer the stream.
      "x-accel-buffering": "no",
    },
  })
}
