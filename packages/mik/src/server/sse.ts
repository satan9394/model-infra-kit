import type { ServerResponse } from "node:http"

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Proxies (nginx) buffer event streams unless told not to.
  "x-accel-buffering": "no",
}

/**
 * One event-stream response. Awaited writes respect backpressure; overlapping
 * event-bus writes close a slow reader before its buffer can grow unbounded.
 * Heartbeats skip blocked writes and every write is a no-op after disconnect.
 */
export class SseStream {
  private closed = false
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private blocked = false

  constructor(
    private readonly res: ServerResponse,
    private readonly heartbeatMs: number,
  ) {
    res.once("close", () => this.close())
    res.once("error", () => this.close())
    res.once("finish", () => this.close())
  }

  get isClosed(): boolean {
    return this.closed || this.res.writableEnded || this.res.destroyed
  }

  /** Open the response: reconnect delay, then a comment so a client can flush. */
  open(): void {
    if (this.res.headersSent || this.isClosed) return
    this.res.writeHead(200, SSE_HEADERS)
    this.res.write("retry: 3000\n\n")
    this.res.write(": connected\n\n")
  }

  /** Emit one named event. `data` is JSON-encoded, `type` is repeated inside it. */
  async send(type: string, data: unknown): Promise<void> {
    await this.write(`event: ${type}\ndata: ${JSON.stringify({ type, at: Date.now(), data })}\n\n`)
  }

  /** A comment frame; SSE clients ignore it but it keeps the socket alive. */
  async comment(text = "ping"): Promise<void> {
    await this.write(`: ${text}\n\n`)
  }

  /** Emit a raw frame, used for the OpenAI-compatible `data: [DONE]` terminator. */
  async raw(frame: string): Promise<void> {
    await this.write(frame)
  }

  startHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.heartbeat || this.isClosed) return
    const timer = setInterval(() => {
      if (!this.blocked) void this.comment()
    }, this.heartbeatMs)
    // A heartbeat must never keep a process (or a test runner) alive.
    timer.unref?.()
    this.heartbeat = timer
  }

  /** Resolves when the client goes away or the response finishes. */
  onClose(listener: () => void): void {
    if (this.isClosed) { listener(); return }
    let called = false
    const done = () => {
      if (called) return
      called = true
      this.res.off("close", done)
      this.res.off("error", done)
      this.res.off("finish", done)
      listener()
    }
    this.res.once("close", done)
    this.res.once("error", done)
    this.res.once("finish", done)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    if (!this.res.writableEnded && !this.res.destroyed) this.res.end()
  }

  private write(chunk: string): Promise<void> {
    if (this.isClosed) return Promise.resolve()
    // Event-bus callbacks cannot await backpressure. Bound their buffer by
    // closing a slow reader rather than silently dropping business events.
    if (this.blocked) { this.close(); return Promise.resolve() }
    try { if (this.res.write(chunk)) return Promise.resolve() }
    catch { this.close(); return Promise.resolve() }
    this.blocked = true
    return new Promise<void>((resolve) => {
      const done = () => {
        this.res.off("drain", done)
        this.res.off("close", done)
        this.res.off("error", done)
        this.res.off("finish", done)
        this.blocked = false
        resolve()
      }
      this.res.once("drain", done)
      this.res.once("close", done)
      this.res.once("error", done)
      this.res.once("finish", done)
    })
  }
}
