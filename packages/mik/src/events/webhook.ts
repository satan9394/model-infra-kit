import { createHmac, timingSafeEqual } from "node:crypto"
import { redactDeep } from "../util/redact.js"
import { isForbiddenAddress } from "../util/outbound-address.js"
import { NOTIFICATION_EVENTS, NotificationBus, type NotificationEvent, type NotificationType } from "./bus.js"

export interface WebhookConfig {
  url: string
  secret: string
  events: NotificationType[]
  timeoutMs?: number
  maxRetries?: number
}

/** CLI files carry env references, never literal signing secrets. */
export function resolveWebhookConfigs(value: unknown, env: NodeJS.ProcessEnv): WebhookConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("Invalid webhook references.")
  return readWebhookConfigs(value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid webhook references.")
    const { secretRef, ...config } = item as Record<string, unknown>
    if (Object.hasOwn(config, "secret") || typeof secretRef !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(secretRef)) throw new Error("Webhook secrets require env references.")
    return { ...config, secret: env[secretRef.slice(4)] }
  }))
}

export function readWebhookConfigs(value: unknown): WebhookConfig[] {
  if (value === undefined) return []
  const invalid = () => { throw new Error("Invalid webhook configuration.") }
  if (!Array.isArray(value) || value.length > 16) return invalid()
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid()
    const config = item as WebhookConfig
    if (typeof config.url !== "string" || typeof config.secret !== "string" || !config.secret || config.secret.length > 4096
      || !Array.isArray(config.events) || !config.events.length || config.events.some(type => !NOTIFICATION_EVENTS.includes(type))) return invalid()
    let url: URL
    try { url = new URL(config.url) } catch { return invalid() }
    if (!["http:", "https:"].includes(url.protocol) || isForbiddenAddress(url.hostname)
      || url.username || url.password || url.search || url.hash || config.url.length > 2048) return invalid()
    const timeoutMs = config.timeoutMs ?? 5000, maxRetries = config.maxRetries ?? 3
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
      || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) return invalid()
    return { url: url.href, secret: config.secret, events: [...new Set(config.events)], timeoutMs, maxRetries }
  })
}

/** Sign timestamp + exact wire bytes, so neither can be replaced independently. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string, now = Date.now()): boolean {
  if (!/^\d{1,13}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(signature)
    || !Number.isFinite(now) || Math.abs(now - Number(timestamp) * 1000) > 300_000) return false
  return timingSafeEqual(Buffer.from(signature), Buffer.from(webhookSignature(secret, timestamp, body)))
}

interface Job { endpoint: number; eventId: string; type: NotificationType; body: string; attempts: number }
export interface WebhookStatus {
  closed: boolean; queued: number; active: number; retrying: number; delivered: number; dropped: number
  endpoints: Array<{ index: number; events: NotificationType[]; timeoutMs: number; maxRetries: number }>
  deadLetters: Array<{ endpoint: number; eventId: string; type: NotificationType; attempts: number; error: string }>
}

/** Limits apply to queued jobs, retries, concurrency and payload bytes. No URLs/secrets in status. */
export class WebhookDispatcher {
  private readonly configs: WebhookConfig[]
  private readonly jobs: Job[] = []
  private readonly timers = new Map<NodeJS.Timeout, Job>()
  private readonly controllers = new Set<AbortController>()
  private readonly deadLetters: WebhookStatus["deadLetters"] = []
  private readonly unsubscribe: () => void
  private closed = false
  private outstanding = 0
  private delivered = 0
  private dropped = 0

  constructor(private readonly bus: NotificationBus, configs: unknown, private readonly transport: typeof fetch = globalThis.fetch) {
    this.configs = readWebhookConfigs(configs)
    this.unsubscribe = bus.subscribe(event => this.enqueue(event))
  }

  private enqueue(event: NotificationEvent): void {
    if (this.closed) return
    const body = JSON.stringify(redactDeep(event), (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)
    if (Buffer.byteLength(body) > 65536) { this.dropped++; return }
    for (let endpoint = 0; endpoint < this.configs.length; endpoint++) {
      if (!this.configs[endpoint]!.events.includes(event.type)) continue
      if (this.outstanding >= 1000) { this.dropped++; continue }
      this.outstanding++
      this.jobs.push({ endpoint, eventId: event.id, type: event.type, body, attempts: 0 })
    }
    this.pump()
  }

  private pump(): void {
    while (!this.closed && this.controllers.size < 4 && this.jobs.length) void this.deliver(this.jobs.shift()!)
  }

  private async deliver(job: Job): Promise<void> {
    const config = this.configs[job.endpoint]!
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
    timeout.unref()
    job.attempts++
    let retry = false, failure: string | undefined
    try {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const response = await this.transport(config.url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", "X-Mik-Timestamp": timestamp,
          "X-Mik-Signature": webhookSignature(config.secret, timestamp, job.body) }, body: job.body })
      // Never buffer an untrusted response body or retain a live reader.
      void response.body?.cancel().catch(() => {})
      if (!response.ok) { failure = `HTTP ${response.status}`; retry = response.status >= 500 }
    } catch {
      // ponytail: generic diagnostics cannot leak arbitrary endpoint error text/credentials.
      failure = "Network failure or timeout"
      retry = true
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
    if (this.closed) return
    if (!failure) { this.delivered++; this.outstanding-- }
    else if (retry && job.attempts <= config.maxRetries!) {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.jobs.push(job)
        this.pump()
      }, 1000 * 2 ** (job.attempts - 1))
      timer.unref()
      this.timers.set(timer, job)
    } else {
      this.outstanding--
      this.deadLetters.push({ endpoint: job.endpoint, eventId: job.eventId, type: job.type, attempts: job.attempts, error: failure })
      if (this.deadLetters.length > 100) this.deadLetters.shift()
    }
    this.pump()
  }

  status(): WebhookStatus {
    return redactDeep({ closed: this.closed, queued: this.jobs.length, active: this.controllers.size, retrying: this.timers.size,
      delivered: this.delivered, dropped: this.dropped + this.bus.dropped,
      endpoints: this.configs.map((config, index) => ({ index, events: [...config.events], timeoutMs: config.timeoutMs!, maxRetries: config.maxRetries! })),
      deadLetters: this.deadLetters.map(entry => ({ ...entry })) })
  }

  test(): boolean { return !this.closed && this.bus.emit("USAGE_RECORDED", { test: true, costMicros: 0n, cacheSavingsMicros: 0n }) }

  close(): void {
    this.closed = true
    this.unsubscribe()
    for (const timer of this.timers.keys()) clearTimeout(timer)
    this.timers.clear()
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.jobs.length = 0
    this.outstanding = 0
  }
}
