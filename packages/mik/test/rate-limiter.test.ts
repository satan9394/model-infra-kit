import { describe, expect, it } from "vitest"
import { RateLimiter } from "../src/quota/rate-limiter.js"
import { QuotaHierarchy } from "../src/quota/hierarchy.js"

describe("exact rolling quota reservations", () => {
  it("matches a simple rolling reference across 10000 deterministic adversarial operations", () => {
    let now = 0, seed = 133
    let rows: {at:number;tokens:number}[] = []
    const limiter = new RateLimiter({maxRpm:17,maxTpm:67}, () => now)
    const random = () => {seed = (Math.imul(seed,1664525)+1013904223) >>> 0;return seed}
    for(let i=0;i<10000;i++) {
      now += random() % 15000
      rows = rows.filter(row => row.at > now - 60000)
      const tokens = random() % 30 + 1
      const total = rows.reduce((sum,row)=>sum+row.tokens,0)
      const allowed = rows.length < 17 && total + tokens <= 67
      const result = limiter.check(tokens)
      expect(result).toMatchObject({allowed,currentRpm:rows.length,currentTpm:total})
      if(allowed) rows.push({at:now,tokens})
      else {
        let freed=0,index=0
        while(index<rows.length) {freed+=rows[index]!.tokens;if(total+tokens-freed<=67)break;index++}
        expect(result.retryAfterSeconds).toBe(Math.max(1,Math.ceil((rows[Math.min(index,rows.length-1)]!.at+60000-now)/1000)))
      }
    }
  })
  it("expires precisely at sixty seconds without fixed-boundary bursts", () => {
    let now = 59_999
    const limiter = new RateLimiter({ maxRpm: 2 }, () => now)
    expect(limiter.check().allowed).toBe(true)
    now = 60_000
    expect(limiter.check().allowed).toBe(true)
    expect(limiter.check()).toMatchObject({ allowed: false, retryAfterSeconds: 60 })
    now = 119_998
    expect(limiter.check()).toMatchObject({ allowed: false, retryAfterSeconds: 1 })
    now = 119_999
    expect(limiter.check().allowed).toBe(true)
    expect(limiter.probe().currentRpm).toBe(2)
  })
  it("does not refund capacity on clock rollback or rejected requests", () => {
    let now = 2000
    const limiter = new RateLimiter({ maxTpm: 10 }, () => now)
    expect(limiter.check(8).allowed).toBe(true)
    now = -1000
    expect(limiter.check(3)).toMatchObject({ allowed: false, currentTpm: 8, retryAfterSeconds: 60 })
    now = 62_000
    expect(limiter.check(10).allowed).toBe(true)
    expect(limiter.check(11)).toMatchObject({ allowed: false, reason: "TPM_EXCEEDED", retryAfterSeconds: 60 })
  })
  it("waits until enough token reservations expire", () => {
    let now = 0
    const limiter = new RateLimiter({ maxTpm: 10 }, () => now)
    limiter.check(3); now = 5000; limiter.check(7)
    expect(limiter.check(9).retryAfterSeconds).toBe(60)
    now = 60_000
    expect(limiter.check(9).retryAfterSeconds).toBe(5)
  })
  it("finds TPM retry correctly after wrapping and bulk expiry", () => {
    let now = 0
    const limiter = new RateLimiter({maxRpm:3,maxTpm:10}, () => now)
    limiter.check(3); now = 1000; limiter.check(3); now = 2000; limiter.check(4)
    now = 60_000
    limiter.check(2)
    expect(limiter.check(6)).toMatchObject({allowed:false,retryAfterSeconds:2,currentTpm:9})
    now = 61_000
    expect(limiter.check(4)).toMatchObject({allowed:true,currentTpm:6})
    now = 62_000
    expect(limiter.probe().currentTpm).toBe(6)
  })
  it("admits exactly the capacity from 1000 simultaneous microtasks", async () => {
    const limiter = new RateLimiter({ maxRpm: 100 }, () => 0)
    const results = await Promise.all(Array.from({ length: 1000 }, async () => limiter.check()))
    expect(results.filter(result => result.allowed)).toHaveLength(100)
    expect(limiter.probe().currentRpm).toBe(100)
  })
  it.each([0, -1, Infinity, NaN, 1.5, 100_001])("rejects invalid limits %s", maxRpm => {
    expect(() => new RateLimiter({ maxRpm })).toThrow()
  })
  it("atomically enforces shared parent, child and unrelated organization", () => {
    const hierarchy = new QuotaHierarchy({ organizations: [{ orgId: "o", maxRpm: 2 }, { orgId: "p", maxRpm: 10 }],
      applications: [{ appId: "a", orgId: "o", maxRpm: 1 }, { appId: "b", orgId: "o", maxRpm: 5 }, { appId: "c", orgId: "p" }] }, () => 0n, () => 0)
    expect(hierarchy.check("a").allowed).toBe(true)
    expect(hierarchy.check("a").allowed).toBe(false)
    expect(hierarchy.check("b").allowed).toBe(true)
    expect(hierarchy.check("b").allowed).toBe(false)
    expect(hierarchy.check("c").allowed).toBe(true)
    expect(hierarchy.snapshot("b")[0]!.org!.currentRpm).toBe(2)
    expect(hierarchy.snapshot("b")[0]!.currentRpm).toBe(1)
  })
  it("uses exact BigInt parent sums above JS safe integer and resets UTC windows", () => {
    let now = Date.parse("2026-10-31T23:59:59Z")
    const ts = now
    const hierarchy = new QuotaHierarchy({ organizations: [{ orgId: "o", dailyHardCapMicros: 9007199254740993n }],
      applications: [{ appId: "a", orgId: "o" }, { appId: "b", orgId: "o" }] },
      (app, from, to) => ts >= from && ts < to ? app === "a" ? 9007199254740992n : 1n : 0n, () => 0, () => now)
    expect(hierarchy.check("b")).toMatchObject({ allowed: false, reason: "ORG_BUDGET_EXCEEDED", retryAfterSeconds: 1 })
    now += 1000
    expect(hierarchy.check("b").allowed).toBe(true)
    now -= 1000
    expect(hierarchy.check("b").allowed).toBe(true)
  })
  it("uses the longest exhausted budget reset and prevents long-ID state allocation", () => {
    const hierarchy = new QuotaHierarchy({ applications: [{ appId: "a", dailyHardCapMicros: 0n, monthlyHardCapMicros: 0n }] }, () => 0n, () => 0, () => Date.parse("2026-10-31T23:59:59Z"))
    expect(hierarchy.check("a").retryAfterSeconds).toBe(1)
    expect(() => hierarchy.check("x".repeat(1_000_000))).toThrow("identity")
    expect(hierarchy.snapshot("unknown")).toEqual([])
    expect(() => hierarchy.check("unknown")).toThrow("configured quota")
    expect(() => new QuotaHierarchy({ applications: Array.from({length: 11}, (_, i) => ({appId: `a${i}`,maxRpm:100_000})) }, () => 0n)).toThrow("memory budget")
  })
})
