import { getI18n } from "@/lib/i18n/server"
import { NextResponse, type NextRequest } from "next/server"
import { mikServerToken, mikServerUrl } from "@/lib/config"
import { isMikProxyPath } from "@/lib/proxy-path"

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

function errorResponse(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ error: { message, type: "dashboard_proxy_error", code } }, { status, headers: { "cache-control": "no-store" } })
}

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const { t } = await getI18n()
  const { path } = await context.params
  if (!isMikProxyPath(path)) {
    return errorResponse(400, t("s373"), "INVALID_PROXY_PATH")
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
    return errorResponse(502, t("s371", mikServerUrl(), message), "MIK_UNREACHABLE")
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
