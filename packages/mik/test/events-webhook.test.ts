import { afterEach, describe, expect, it, vi } from "vitest"
import { NotificationBus, NOTIFICATION_EVENTS } from "../src/events/bus.js"
import { WebhookDispatcher, readWebhookConfigs, resolveWebhookConfigs, verifyWebhookSignature, webhookSignature } from "../src/events/webhook.js"

const config = { url: "http://127.0.0.1:3219/hook", secret: "plain-signing-secret", events: [...NOTIFICATION_EVENTS] }
const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(close => close()); vi.useRealTimers() })
function fixture(transport: typeof fetch, overrides = {}) {
  const bus = new NotificationBus(), dispatcher = new WebhookDispatcher(bus, [{ ...config, ...overrides }], transport)
  disposers.push(() => { dispatcher.close(); bus.close() })
  return { bus, dispatcher }
}

describe("signed webhook delivery", () => {
  it("uses exact signed redacted bytes and integer strings", async () => {
    vi.useFakeTimers()
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const { bus, dispatcher } = fixture(transport)
    bus.emit("USAGE_RECORDED", { costMicros: 9007199254740993n, cacheSavingsMicros: 1n, api_key: "plain-key", token: "request-secret" })
    expect(transport).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    const [, init] = transport.mock.calls[0]!, headers = init!.headers as Record<string, string>, body = init!.body as string
    expect(body).not.toContain("plain-key")
    expect(body).not.toContain("request-secret")
    expect(JSON.parse(body).data.costMicros).toBe("9007199254740993")
    expect(verifyWebhookSignature(config.secret, headers["X-Mik-Timestamp"]!, body, headers["X-Mik-Signature"]!)).toBe(true)
    expect(init!.redirect).toBe("error")
    expect(dispatcher.status().delivered).toBe(1)
    expect(JSON.stringify(dispatcher.status())).not.toContain(config.secret)
  })
  it("rejects expired, future, malformed and tampered signature/body/timestamp", () => {
    const timestamp = "1700000000", now = 1700000000000, body = '{"costMicros":"1"}'
    const signature = webhookSignature(config.secret, timestamp, body)
    expect(verifyWebhookSignature(config.secret, timestamp, body, signature, now)).toBe(true)
    expect(verifyWebhookSignature(config.secret, timestamp, body, signature, now + 300001)).toBe(false)
    expect(verifyWebhookSignature(config.secret, timestamp, body, signature, now - 300001)).toBe(false)
    expect(verifyWebhookSignature(config.secret, timestamp, body + " ", signature, now)).toBe(false)
    expect(verifyWebhookSignature(config.secret, String(Number(timestamp) + 1), body, signature, now)).toBe(false)
    expect(verifyWebhookSignature(config.secret, timestamp, body, "sha256=x", now)).toBe(false)
  })
  it("retries 500 exactly at 1s, 2s, 4s then retains a bounded dead letter", async () => {
    vi.useFakeTimers()
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 500 }))
    const { bus, dispatcher } = fixture(transport)
    bus.emit("RATE_LIMITED", {})
    await vi.advanceTimersByTimeAsync(0)
    expect(transport).toHaveBeenCalledTimes(1)
    for (const [delay, count] of [[1000, 2], [2000, 3], [4000, 4]]) {
      await vi.advanceTimersByTimeAsync(delay! - 1)
      expect(transport).toHaveBeenCalledTimes(count! - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(transport).toHaveBeenCalledTimes(count!)
    }
    expect(dispatcher.status()).toMatchObject({ active: 0, queued: 0, retrying: 0, deadLetters: [{ attempts: 4, error: "HTTP 500" }] })
  })
  it("does not retry 4xx and caps dead letters at the last100", async () => {
    vi.useFakeTimers()
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 403 }))
    const { bus, dispatcher } = fixture(transport)
    for (let i = 0; i < 120; i++) bus.emit("USAGE_RECORDED", {})
    await vi.runAllTimersAsync()
    expect(transport).toHaveBeenCalledTimes(120)
    expect(dispatcher.status().deadLetters).toHaveLength(100)
    expect(dispatcher.status().deadLetters.every(entry => entry.attempts === 1)).toBe(true)
  })
  it("timeouts retry without endpoint errors leaking and close aborts active work", async () => {
    vi.useFakeTimers()
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("plain-signing-secret token=raw")), { once: true })
    }))
    const { bus, dispatcher } = fixture(transport, { timeoutMs: 10 })
    bus.emit("USAGE_RECORDED", {})
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(dispatcher.status().retrying).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(dispatcher.status().active).toBe(1)
    dispatcher.close()
    await vi.runAllTimersAsync()
    expect(transport).toHaveBeenCalledTimes(2)
    expect(dispatcher.status()).toMatchObject({ closed: true, active: 0, retrying: 0, queued: 0 })
  })
  it("caps all outstanding deliveries and payload bytes when endpoints hang", async () => {
    vi.useFakeTimers()
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }))
    const { bus, dispatcher } = fixture(transport)
    for (let batch = 0; batch < 2; batch++) {
      for (let i = 0; i < 1000; i++) bus.emit("USAGE_RECORDED", {})
      await vi.advanceTimersByTimeAsync(0)
      // Drain all32-item immediate batches without reaching the transport timeout.
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(1)
    }
    expect(dispatcher.status()).toMatchObject({ active: 4, queued: 996, dropped: 1000 })
    dispatcher.close()
    const other = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response(null)))
    other.bus.emit("USAGE_RECORDED", { large: "x".repeat(65537) })
    await vi.advanceTimersByTimeAsync(1)
    expect(other.dispatcher.status().dropped).toBe(1)
  })
  it("filters subscriptions and contains failed connections", async () => {
    vi.useFakeTimers()
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("api_key=plain"))
    const { bus, dispatcher } = fixture(transport, { events: ["RATE_LIMITED"], maxRetries: 0 })
    bus.emit("USAGE_RECORDED", {})
    bus.emit("RATE_LIMITED", {})
    await vi.advanceTimersByTimeAsync(1)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(dispatcher.status().deadLetters[0]!.error).toBe("Network failure or timeout")
  })
  it.each([{ url: "file:///bad" }, { url: "http://169.254.169.254/" }, { url: "https://user:pass@example.com/" }, { url: "https://example.com/?token=raw" }, { timeoutMs: 0 }, { maxRetries: 4 }, { events: ["bad"] }, { secret: "" }])("refuses unsafe or invalid configuration %j", override => {
    expect(() => readWebhookConfigs([{ ...config, ...override }])).toThrow("Invalid webhook configuration")
  })
  it("resolves signing secrets only from injected env references for file configuration", () => {
    expect(resolveWebhookConfigs([{ url: config.url, events: config.events, secretRef: "env:HOOK" }], { HOOK: "injected" })[0]!.secret).toBe("injected")
    expect(() => resolveWebhookConfigs([config], {})).toThrow("env references")
    expect(() => resolveWebhookConfigs([{ url: config.url, events: config.events, secretRef: "env:HOOK" }], {})).toThrow()
  })
})
