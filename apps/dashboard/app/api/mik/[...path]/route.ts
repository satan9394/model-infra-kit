import { NextResponse, type NextRequest } from "next/server"
import { mikServerToken, mikServerUrl } from "@/lib/config"

/**
 * The dashboard's own proxy in front of `mik serve`.
 *
 * Client components (test buttons, price forms, live refreshes) talk to this
 * route instead of 3211 directly, for three reasons: the browser never needs
 * the bearer token, no CORS on the mik server is required (it ships CORS off),
 * and `MIK_SERVER_URL` stays a server-side concern.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Path segments a caller may address. No `..`, no separators, no empty parts. */
const SEGMENT = /^[A-Za-z0-9._~:@-]+$/

function errorResponse(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ error: { message, type: "dashboard_proxy_error", code } }, { status, headers: { "cache-control": "no-store" } })
}

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const { path } = await context.params
  if (path.length === 0 || !path.every((segment) => SEGMENT.test(segment))) {
    return errorResponse(400, "非法的代理路径。", "INVALID_PROXY_PATH")
  }

  const target = `${mikServerUrl()}/api/${path.map((segment) => encodeURIComponent(segment)).join("/")}${request.nextUrl.search}`
  const method = request.method.toUpperCase()
  const headers: Record<string, string> = { accept: "application/json" }
  const token = mikServerToken()
  if (token) headers.authorization = `Bearer ${token}`

  let body: string | undefined
  if (method !== "GET" && method !== "HEAD") {
    const raw = await request.text()
    if (raw.length > 0) {
      headers["content-type"] = request.headers.get("content-type") ?? "application/json"
      body = raw
    }
  }

  let upstream: Response
  try {
    upstream = await fetch(target, { method, headers, body, cache: "no-store", signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(502, `无法连接 mik serve（${mikServerUrl()}）：${message}`, "MIK_UNREACHABLE")
  }

  const text = await upstream.text()
  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
