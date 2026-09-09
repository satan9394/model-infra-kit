import type { IncomingMessage, ServerResponse } from "node:http"
import type { ModelInfra } from "../hub.js"
import type { EventBus } from "./events.js"
import type { SseStream } from "./sse.js"

/**
 * Everything a route handler needs. Handlers are plain functions of this
 * context, which keeps the HTTP layer free of framework state.
 */
export interface ServerContext {
  hub: ModelInfra
  /** Fan-out for `GET /api/events`; fed by the taps in `events.ts`. */
  bus: EventBus
  req: IncomingMessage
  res: ServerResponse
  url: URL
  /** Decoded `:name` segments of the matched route. */
  params: Record<string, string>
  /** The URL this server is published under, without a trailing slash. */
  origin: string
  /** Heartbeat interval of every SSE endpoint, in milliseconds. */
  heartbeatMs: number
  /** When this server started listening. */
  startedAt: number
  /**
   * Register an open event stream: it is counted, and `close()` ends it so a
   * shutdown never hangs on a connected dashboard.
   */
  trackSse(stream: SseStream): void
}

/**
 * A failure with an HTTP meaning. Anything else that escapes a handler is
 * reported as a 500 with a generic message, so internals never leak.
 */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code = "INVALID_REQUEST") {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
  }
}
