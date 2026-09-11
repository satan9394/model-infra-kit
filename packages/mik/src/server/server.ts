import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createConnection, type AddressInfo } from "node:net"
import { ModelInfraError } from "../errors.js"
import type { ModelInfra } from "../hub.js"
import { registerApiRoutes } from "./api.js"
import { HttpError, type ServerContext } from "./context.js"
import { acquireEventBus } from "./events.js"
import {
  bearerToken,
  pathSegments,
  resolveCors,
  safeEqual,
  sendError,
  sendJson,
  writeCors,
  type CorsOptions,
} from "./http.js"
import { buildOpenApiDocument } from "./openapi.js"
import { handleChatCompletions, handleListModels, toHttpError } from "./openai.js"
import { Router } from "./router.js"
import { SseStream } from "./sse.js"

/** Loopback only: this API is not meant to be exposed to a network. */
export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_PORT = 3211
/** `docs/interfaces.md`: one heartbeat comment every 15 seconds. */
export const DEFAULT_HEARTBEAT_MS = 15_000

export interface ServerOptions {
  hub: ModelInfra
  /** Defaults to 3211. Use 0 for an ephemeral port (tests). */
  port?: number
  /** Defaults to `127.0.0.1`. */
  host?: string
  /** When set, every endpoint except `GET /api/health` needs it as a bearer token. */
  token?: string
  /** Off by default. `true` allows any origin; pass options to narrow it. */
  cors?: boolean | CorsOptions
  /** SSE heartbeat interval in milliseconds. Defaults to 15000. */
  heartbeatMs?: number
}

export interface ServerHandle {
  /** e.g. `http://127.0.0.1:3211` — also injected into `hub.baseUrl` as `<url>/v1`. */
  readonly url: string
  readonly port: number
  readonly host: string
  /** Open event streams. Diagnostic only; useful for leak checks. */
  readonly sseClients: number
  close(): Promise<void>
}

function probeHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1"
  if (host === "::" || host === "::0") return "::1"
  return host
}

/** Host as it must appear in a URL (IPv6 literals need brackets). */
function urlHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1"
  if (host === "::" || host === "::0") return "[::1]"
  return host.includes(":") ? `[${host}]` : host
}

/**
 * Is something already listening there? A TCP probe answers the question for
 * this exact host/port, which is what "do not steal the port" means; the
 * message still points at the `netstat` command for a human.
 */
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1000)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

async function assertPortFree(port: number, host: string): Promise<void> {
  if (port === 0) return
  if (!(await isPortInUse(port, probeHost(host)))) return
  throw new ModelInfraError(
    `Port ${port} is already in use on ${host}. Pick another port (check with: netstat -ano | findstr :${port}).`,
    { code: "CONNECTION" },
  )
}

function listenError(error: NodeJS.ErrnoException, port: number, host: string): ModelInfraError {
  if (error.code === "EADDRINUSE") {
    return new ModelInfraError(
      `Port ${port} is already in use on ${host}. Pick another port (check with: netstat -ano | findstr :${port}).`,
      { code: "CONNECTION", cause: error },
    )
  }
  if (error.code === "EACCES") {
    return new ModelInfraError(`Not allowed to bind ${host}:${port}.`, { code: "CONNECTION", cause: error })
  }
  return new ModelInfraError(`Could not start the HTTP server on ${host}:${port}: ${error.message}`, {
    code: "CONNECTION",
    cause: error,
  })
}

function isPublicRoute(segments: string[]): boolean {
  return segments.length === 2 && segments[0] === "api" && segments[1] === "health"
}

/** The methods that mutate state behind the `/api` and `/v1` surfaces. */
function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE"
}

/**
 * Start the HTTP surface of a hub: the OpenAI-compatible endpoints under `/v1`,
 * the metering REST API under `/api`, the event stream and the OpenAPI document.
 *
 * The listener is bound before this resolves, so the returned `url` is usable
 * immediately and `hub.baseUrl` points at the real port.
 */
export async function createServer(options: ServerOptions): Promise<ServerHandle> {
  const { hub } = options
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? DEFAULT_HOST
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const token = options.token?.trim() || undefined
  const cors = resolveCors(options.cors)

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ModelInfraError(`Invalid port "${String(port)}".`, { code: "INVALID_REQUEST" })
  }

  await assertPortFree(port, host)

  const { bus, release } = acquireEventBus(hub)
  const streams = new Set<SseStream>()
  const startedAt = Date.now()
  let origin = `http://${urlHost(host)}:${port}`

  const trackSse = (stream: SseStream): void => {
    streams.add(stream)
    stream.onClose(() => {
      streams.delete(stream)
    })
  }

  const router = new Router()
  registerApiRoutes(router)
  router.add("GET", "/openapi.json", (ctx) => {
    sendJson(ctx.res, 200, buildOpenApiDocument({ origin: ctx.origin, secured: token !== undefined }))
  })
  router.add("POST", "/v1/chat/completions", handleChatCompletions)
  router.add("GET", "/v1/models", handleListModels)

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", origin)
      if (cors) writeCors(res, cors)

      const method = (req.method ?? "GET").toUpperCase()
      // A preflight request cannot carry the Authorization header, so it is
      // answered before the auth gate.
      if (method === "OPTIONS" && cors) {
        res.writeHead(204)
        res.end()
        return
      }

      const segments = pathSegments(url)
      if (token) {
        if (!isPublicRoute(segments)) {
          const presented = bearerToken(req)
          if (!presented || !safeEqual(presented, token)) {
            sendError(res, 401, "Missing or invalid credentials.", "AUTH", {
              "www-authenticate": 'Bearer realm="model-infra-kit"',
            })
            return
          }
        }
      } else if (isWriteMethod(method) && !isPublicRoute(segments)) {
        // Safe by default: without a token the write surface is disabled and
        // the answer carries the way out. GET reads and /api/health stay open.
        sendError(
          res,
          401,
          "Write endpoints are disabled because no token is configured. Set --token or MIK_SERVER_TOKEN to enable them.",
          "AUTH",
          { "www-authenticate": 'Bearer realm="model-infra-kit"' },
        )
        return
      }

      const match = router.match(method, segments)
      if (!match.route) {
        if (match.allowed.length > 0) {
          sendError(res, 405, `${method} is not allowed for ${url.pathname}.`, "METHOD_NOT_ALLOWED", {
            allow: match.allowed.join(", "),
          })
          return
        }
        sendError(res, 404, `No route matches ${url.pathname}.`, "NOT_FOUND")
        return
      }

      const ctx: ServerContext = {
        hub,
        bus,
        req,
        res,
        url,
        params: match.params,
        origin,
        heartbeatMs,
        startedAt,
        trackSse,
      }
      await match.route.handler(ctx)
    } catch (error) {
      const mapped = toHttpError(error)
      // A streamed response already committed its status; all that is left is
      // to close it rather than append a JSON body to an event stream.
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      sendError(res, mapped.status, mapped.message, mapped.code)
    }
  }

  const server = createNodeServer((req, res) => {
    void handleRequest(req, res)
  })
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening)
      reject(listenError(error, port, host))
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })

  // Keep a late socket error from crashing the host process.
  server.on("error", () => {})

  const address = server.address() as AddressInfo | null
  const boundPort = typeof address === "object" && address ? address.port : port
  origin = `http://${urlHost(host)}:${boundPort}`
  hub.setBaseUrl(`${origin}/v1`)

  let closing: Promise<void> | undefined

  return {
    url: origin,
    port: boundPort,
    host,
    get sseClients(): number {
      return streams.size
    },
    close(): Promise<void> {
      if (closing) return closing
      closing = (async () => {
        release()
        for (const stream of [...streams]) stream.close()
        streams.clear()
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          // Event streams and keep-alive sockets would otherwise hold shutdown.
          server.closeAllConnections()
        })
      })()
      return closing
    },
  }
}

/** Re-exported for callers that want to build their own error responses. */
export { HttpError }
