import { afterEach, describe, expect, it, vi } from "vitest"
import { NotificationBus } from "../src/events/bus.js"

afterEach(() => vi.useRealTimers())
describe("bounded deferred notification bus", () => {
  it("never invokes work or listeners on the emitting stack and isolates failures", async () => {
    const bus = new NotificationBus(), received: unknown[] = []
    bus.subscribe(() => { throw new Error("observer") })
    bus.subscribe(event => received.push(event))
    bus.emit("USAGE_RECORDED", { costMicros: 9007199254740993n, apiKey: "plain-key", token: "plain-token", nested: { authorization: "Basic abc" } })
    expect(received).toHaveLength(0)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(received).toMatchObject([{ data: { costMicros: 9007199254740993n, apiKey: "[REDACTED]", token: "[REDACTED]", nested: { authorization: "[REDACTED]" } } }])
    bus.close()
  })
  it("caps deferred producers, yields in batches and cancels scheduled work", async () => {
    const bus = new NotificationBus(), work = vi.fn()
    for (let i = 0; i < 2000; i++) bus.defer(work)
    expect(bus.queued).toBe(1000)
    expect(bus.dropped).toBe(1000)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(work).toHaveBeenCalledTimes(32)
    bus.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(work).toHaveBeenCalledTimes(32)
    expect(bus.emit("RATE_LIMITED", {})).toBe(false)
  })
})
