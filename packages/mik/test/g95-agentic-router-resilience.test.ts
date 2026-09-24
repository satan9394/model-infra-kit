import { describe, expect, it } from "vitest"
import { KeyPool } from "../src/router/key-pool.js"

describe("G95 API key pool", () => {
  it("round-robins credential references while resolving secrets only in memory", () => {
    const pool = new KeyPool()
    const secrets = new Map([
      ["env:MIK_G95_A", "secret-a"],
      ["env:MIK_G95_B", "secret-b"],
    ])
    const resolve = (ref: string) => secrets.get(ref) ?? null

    expect(pool.resolve("provider", ["env:MIK_G95_A", "env:MIK_G95_B"], resolve)?.apiKey).toBe("secret-a")
    expect(pool.resolve("provider", ["env:MIK_G95_A", "env:MIK_G95_B"], resolve)?.apiKey).toBe("secret-b")
    expect(JSON.stringify(pool)).not.toContain("secret-a")
    expect(JSON.stringify(pool)).not.toContain("secret-b")
  })

  it("cools a rate-limited key and selects another live reference", () => {
    const pool = new KeyPool()
    const refs = ["env:MIK_G95_A", "env:MIK_G95_B"]
    const resolve = (ref: string) => `secret-${ref.slice(-1).toLowerCase()}`

    expect(pool.resolve("provider", refs, resolve, 1_000)?.ref).toBe(refs[0])
    pool.coolCurrent("provider", 30_000, 1_000)

    expect(pool.resolve("provider", refs, resolve, 1_001)?.ref).toBe(refs[1])
    expect(pool.resolve("provider", refs, resolve, 32_000)?.ref).toBe(refs[0])
  })

  it("skips unresolved references and reports the number of configured keys", () => {
    const pool = new KeyPool()
    const refs = ["env:MISSING", "env:AVAILABLE"]

    expect(pool.keyCount(refs)).toBe(2)
    expect(pool.resolve("provider", refs, (ref) => (ref.endsWith("AVAILABLE") ? "secret" : null))?.ref).toBe(
      "env:AVAILABLE",
    )
  })
})
