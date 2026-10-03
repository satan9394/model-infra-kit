import type { IncomingMessage, ServerResponse } from "node:http"
import type { ModelInfra } from "../hub.js"
import type { EventBus } from "./events.js"
import type { SseStream } from "./sse.js"
import { randomUUID } from "node:crypto"
import { redact } from "../util/redact.js"

export interface ActiveConnection {
  id: string
  kind: "chat" | "events"
  startedAt: number
  model: string
  ip: string
  appId: string
}

/** Process-local metadata only. App ownership is compared before redaction. */
export class InFlightTracker {
  private readonly active = new Map<string, ActiveConnection>()
  constructor(private readonly secrets: string[] = []) {}
  start(connection: Omit<ActiveConnection, "id" | "startedAt">): { updateModel(model: string): void; close(): void } {
    const id = randomUUID()
    this.active.set(id, { ...connection, id, startedAt: Date.now() })
    return {
      updateModel: (model) => { const entry = this.active.get(id); if (entry) entry.model = model },
      close: () => { this.active.delete(id) },
    }
  }
  snapshot(appId: string): { active: number; requests: number; events: number; connections: ActiveConnection[] } {
    const safe = (value: string) => {
      for (const secret of this.secrets) value = value.split(secret).join("[REDACTED]")
      return redact(value).slice(0, 128)
    }
    const connections = [...this.active.values()].filter(entry => entry.appId === appId).map(entry => ({
      ...entry, model: safe(entry.model), ip: safe(entry.ip), appId: safe(entry.appId),
    }))
    return { active: connections.length, requests: connections.filter(entry => entry.kind === "chat").length,
      events: connections.filter(entry => entry.kind === "events").length, connections }
  }
  clear(): void { this.active.clear() }
}

/**
 * Everything a route handler needs. Handlers are plain functions of this
 * context, which keeps the HTTP layer free of framework state.
 */
export interface ServerContext {
  hub: ModelInfra
  /** Token metadata only; the bearer secret never reaches handlers. */
  auth?: { scopes: string[]; appId?: string }
  appId?: string
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
  /** Update metadata for an authenticated active chat; never retain prompts. */
  updateConnectionModel?(model: string): void
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
