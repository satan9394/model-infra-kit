import { describe, expect, it } from "vitest"
import { QoSTracker } from "../src/router/qos-tracker.js"

describe("QoS ring and EWMA", () => {
  it("smooths RTT and observed TTFT with alpha 0.2 without inventing missing TTFT", () => {
    const q = new QoSTracker()
    q.record("p", "m", 100, true)
    expect(q.snapshot()[0]?.ewmaTtftMs).toBeNull()
    q.record("p", "m", 200, true, 50)
    q.record("p", "m", 200, true, 100)
    expect(q.snapshot()[0]).toMatchObject({ ewmaRttMs: 136, ewmaTtftMs: 60, sampleCount: 3 })
    for (let i = 0; i < 60; i++) q.record("p", "m", 200, true)
    expect(q.snapshot()[0]!.ewmaRttMs).toBeCloseTo(200, 3)
  })
  it("computes actual window variance, punishes jitter and evicts old samples", () => {
    const q = new QoSTracker(2)
    q.record("p", "m", 100, true)
    const stable = q.snapshot()[0]!.qosScore
    q.record("p", "m", 300, false)
    expect(q.snapshot()[0]).toMatchObject({ jitterMs: 100, jitterVarianceMs2: 10000, successRate: 0.5, consecutiveFailures: 1 })
    expect(q.snapshot()[0]!.qosScore).toBeLessThan(stable)
    q.record("p", "m", 100, true)
    q.record("p", "m", 100, true)
    expect(q.snapshot()[0]).toMatchObject({ jitterMs: 0, successRate: 1, consecutiveFailures: 0 })
  })
  it("drops congestion weight and smoothly recovers while retaining probes", () => {
    const q = new QoSTracker()
    q.register("p", "m", 100)
    for (let i = 0; i < 32; i++) q.record("p", "m", 100, true)
    const normal = q.weight("p", "m")
    for (let i = 0; i < 32; i++) q.record("p", "m", 2500, true)
    const slow = q.weight("p", "m")
    expect(slow).toBeLessThan(normal)
    q.record("p", "m", 100, true)
    expect(q.weight("p", "m")).toBeLessThan(normal)
    for (let i = 0; i < 64; i++) q.record("p", "m", 100, true)
    expect(q.weight("p", "m")).toBe(normal)
    for (let i = 0; i < 32; i++) q.record("p", "m", 100, false)
    expect(q.snapshot()[0]).toMatchObject({ qosScore: 5, effectiveWeight: 5 })
    expect(q.weight("p", "m", 1)).toBe(1)
  })
  it("isolates provider/model pairs and returns detached snapshots", () => {
    const q = new QoSTracker()
    q.record("p", "m", 100, true)
    q.record("p", "other", 2500, false)
    q.record("other", "m", 50, true)
    q.snapshot()[0]!.qosScore = 0
    expect(q.weight("p", "m")).toBe(85)
    expect(q.snapshot()).toHaveLength(3)
  })
  it.each([NaN, Infinity, -1, 86_400_001])("rejects invalid RTT %s without mutating", value => {
    const q = new QoSTracker()
    expect(() => q.record("p", "m", value, true)).toThrow("Invalid QoS sample")
    expect(q.snapshot()).toEqual([])
  })
  it("rejects invalid TTFT, window and weights", () => {
    expect(() => new QoSTracker(0)).toThrow()
    const q = new QoSTracker()
    expect(() => q.record("p", "m", 100, true, 101)).toThrow()
    expect(() => q.register("p", "m", 0)).toThrow()
  })
})
