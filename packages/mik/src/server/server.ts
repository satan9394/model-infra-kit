import { autoBypass } from "../auto-context.js"
import { handleMessages, handleNativeCompletion } from "./native.js"
import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createConnection, type AddressInfo } from "node:net"
import { ModelInfraError } from "../errors.js"
import { assertReloadCompatibility, type ModelInfra } from "../hub.js"
import { registerApiRoutes } from "./api.js"
import { HttpError, InFlightTracker, type ServerContext } from "./context.js"
import { acquireEventBus, EventBus } from "./events.js"
import { authenticate, endpointScope, requireScope, resolveTokens, validateTokens, type GatewayToken } from "./auth.js"
import {
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
import { MetricsExporter, METRICS_CONTENT_TYPE } from "./metrics.js"
import { HotReloadManager, prepareConfig, type ReloadOptions, type ReloadResult } from "./reload.js"

/** Loopback only: this API is not meant to be exposed to a network. */
export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_PORT = 3211
/** `docs/interfaces.md`: one heartbeat comment every 15 seconds. */
export const DEFAULT_HEARTBEAT_MS = 15_000

export interface ServerOptions {
  hub: ModelInfra
  /** Opt-in file reload; the CLI supplies its resolved configuration path. */
  reload?: ReloadOptions
  /** Defaults to 3211. Use 0 for an ephemeral port (tests). */
  port?: number
  /** Defaults to `127.0.0.1`. */
  host?: string
  /** When set, every endpoint except `GET /api/health` needs it as a bearer token. */
  token?: string
  /** In-memory tokens. When omitted, MIK_SERVER_TOKENS is a JSON array. */
  tokens?: GatewayToken[]
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
  reloadConfig(): Promise<ReloadResult>
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

/**
 * Start the HTTP surface of a hub: the OpenAI-compatible endpoints under `/v1`,
 * the metering REST API under `/api`, the event stream and the OpenAPI document.
 *
 * The listener is bound before this resolves, so the returned `url` is usable
 * immediately and `hub.baseUrl` points at the real port.
 */
export async function createServer(options: ServerOptions): Promise<ServerHandle> {
  const { hub } = options
  if (options.reload) assertReloadCompatibility(hub, options.reload.hubOptions)
  if (options.reload?.hubOptions.storage && (! ("type" in options.reload.hubOptions.storage) || options.reload.hubOptions.storage.type !== "sqlite")) {
    throw new ModelInfraError("Configuration reload requires file-backed SQLite storage.", { code: "INVALID_REQUEST" })
  }
  if (options.reload && (options.reload.hubOptions.db === ":memory:"
    || options.reload.hubOptions.storage && "type" in options.reload.hubOptions.storage && options.reload.hubOptions.storage.type === "sqlite" && options.reload.hubOptions.storage.path === ":memory:")) {
    throw new ModelInfraError("Configuration reload requires a durable shared ledger.", { code: "INVALID_REQUEST" })
  }
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? DEFAULT_HOST
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const token = options.token?.trim() || undefined
  const tokens = options.tokens === undefined ? resolveTokens(undefined, process.env) : validateTokens(options.tokens)
  if (token) {
    if (tokens.some((entry) => safeEqual(entry.token, token))) throw new HttpError(400, "Duplicate gateway token configuration.")
    tokens.push({ token, scopes: ["admin"] })
  }
  const cors = resolveCors(options.cors)

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ModelInfraError(`Invalid port "${String(port)}".`, { code: "INVALID_REQUEST" })
  }

  await assertPortFree(port, host)

  if (options.reload) await hub.providers.isolate()
  const liveBus = new EventBus()
  const metrics = new MetricsExporter(hub, tokens.map(entry => entry.token))
  function createResources(value: ModelInfra, credentials: GatewayToken[], owned: boolean) {
    const events = acquireEventBus(value)
    const unsubscribe = events.bus.subscribe(event => liveBus.emit(event))
    metrics.attach(value, credentials.map(entry => entry.token))
    return { hub: value, tokens: credentials, bus: liveBus, release: () => { unsubscribe(); events.release() }, owned,
      connections: new InFlightTracker(credentials.map(entry => entry.token)) }
  }
  const resources = new Map<ModelInfra, ReturnType<typeof createResources>>()
  const initial = createResources(hub, tokens, false)
  resources.set(hub, initial)
  const manager: HotReloadManager<ReturnType<typeof createResources>> = new HotReloadManager(initial, async () => {
    if (!options.reload) throw new Error("Reload is not configured.")
    const prepared = await prepareConfig({ ...options.reload, token, currentHub: manager.activeContext.hub })
    prepared.hub.setBaseUrl(`${origin}/v1`)
    const next = createResources(prepared.hub, prepared.tokens, true)
    resources.set(prepared.hub, next)
    return next
  }, async value => {
    metrics.detach(value.hub)
    value.release()
    value.connections.clear()
    resources.delete(value.hub)
    if (value.owned) await value.hub.close()
  }, options.reload?.onWarn)
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
  router.add("GET", "/api/connections", (ctx) => {
    const entries = [...resources.values()].flatMap(value => value.connections.snapshot(ctx.appId ?? ctx.hub.appId).connections)
    sendJson(ctx.res, 200, { active: entries.length, requests: entries.filter(entry => entry.kind === "chat").length,
      events: entries.filter(entry => entry.kind === "events").length, connections: entries })
  })
  router.add("GET", "/metrics", (ctx) => {
    requireScope("read:usage")(ctx)
    ctx.res.writeHead(200, { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" })
    ctx.res.end(metrics.render(ctx.appId ?? ctx.hub.appId, ctx.hub))
  })
  router.add("GET", "/openapi.json", (ctx) => {
    sendJson(ctx.res, 200, buildOpenApiDocument({ origin: ctx.origin, secured: resources.get(ctx.hub)!.tokens.length > 0 }))
  })
  router.add("POST", "/api/reload", async ctx => {
    requireScope("admin")(ctx)
    if (!options.reload) throw new HttpError(409, "Configuration reload is not enabled.")
    const result = await manager.reloadConfig()
    sendJson(ctx.res, result.reloaded ? 200 : 400, result)
  })
  router.add("POST", "/v1/messages", handleMessages)
  router.add("POST", "/v1/responses", ctx => handleNativeCompletion(ctx, "responses"))
  router.add("POST", "/v1/chat/completions", ctx => ctx.req.headers["x-mik-auto-protocol"] === undefined
    ? handleChatCompletions(ctx) : handleNativeCompletion(ctx))
  router.add("GET", "/v1/models", handleListModels)

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const lease = manager.acquire()
    const { hub, bus, tokens, connections } = lease.context
    const releaseRequest = () => {
      lease.release()
      res.off("finish", releaseRequest)
      res.off("close", releaseRequest)
      res.off("error", releaseRequest)
    }
    res.once("finish", releaseRequest)
    res.once("close", releaseRequest)
    res.once("error", releaseRequest)
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
      let principal: GatewayToken | undefined
      if (tokens.length > 0) {
        if (!isPublicRoute(segments)) {
          principal = authenticate(req, tokens)
          if (!principal) {
            sendError(res, 401, "Missing or invalid credentials.", "AUTH", {
              "www-authenticate": 'Bearer realm="model-infra-kit"',
            })
            return
          }
        }
      } else if (!isPublicRoute(segments) && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) {
        sendError(
          res,
          401,
          "Remote requests require a configured gateway token.",
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
        auth: principal ? { scopes: principal.scopes, appId: principal.appId } : { scopes: ["admin"] },
        appId: principal?.appId ?? hub.appId,
      }
      if (!isPublicRoute(segments)) requireScope(endpointScope(method, segments))(ctx)
      const requestedApps = [...url.searchParams.getAll("appId"), ...url.searchParams.getAll("app_id")]
      const headerApp = req.headers["x-mik-app-id"]
      if (headerApp !== undefined) requestedApps.push(...(Array.isArray(headerApp) ? headerApp : [headerApp]))
      if (requestedApps.some((value) => value !== ctx.appId)) throw new HttpError(403, "insufficient_scope", "FORBIDDEN")
      const routePath = segments.join("/")
      const kind = method === "POST" && ["v1/chat/completions", "v1/messages", "v1/responses"].includes(routePath) ? "chat"
        : method === "GET" && routePath === "api/events" ? "events" : undefined
      if (kind) {
        const connection = connections.start({ kind, model: "pending", ip: req.socket.remoteAddress ?? "unknown", appId: ctx.appId! })
        ctx.updateConnectionModel = connection.updateModel
        const cleanup = () => {
          connection.close()
          res.off("finish", cleanup)
          res.off("close", cleanup)
          res.off("error", cleanup)
          req.off("aborted", cleanup)
        }
        res.once("finish", cleanup)
        res.once("close", cleanup)
        res.once("error", cleanup)
        req.once("aborted", cleanup)
      }
      await autoBypass.run(true, () => hub.usage.withAppScope(ctx.appId!, () => match.route!.handler(ctx)))
    } catch (error) {
      const mapped = toHttpError(error)
      // A streamed response already committed its status; all that is left is
      // to close it rather than append a JSON body to an event stream.
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      if (mapped.status === 403 && mapped.code === "FORBIDDEN") {
        sendJson(res, 403, { error: { message: "insufficient_scope", code: "FORBIDDEN" } })
      } else sendError(res, mapped.status, mapped.message, mapped.code)
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
      void manager.close()
      metrics.close()
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
  if (options.reload) manager.listen(options.reload.configPath, options.reload.watch ?? false, options.reload.watchIntervalMs)

  let closing: Promise<void> | undefined

  return {
    url: origin,
    port: boundPort,
    host,
    get sseClients(): number {
      return streams.size
    },
    reloadConfig: () => manager.reloadConfig(),
    close(): Promise<void> {
      if (closing) return closing
      closing = (async () => {
        for (const stream of [...streams]) stream.close()
        streams.clear()
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          // Event streams and keep-alive sockets would otherwise hold shutdown.
          server.closeAllConnections()
        })
        await manager.close()
        metrics.close()
      })()
      return closing
    },
  }
}

/** Re-exported for callers that want to build their own error responses. */
export { HttpError }
