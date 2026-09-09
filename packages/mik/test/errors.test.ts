import { describe, expect, it } from "vitest"
import {
  ModelInfraError,
  isModelInfraError,
  toModelInfraError,
  type ModelInfraErrorCode,
} from "../src/errors.js"

const SK_KEY = "sk-abcdefgh12345678"
const HEX_KEY = "abcdef0123456789abcdef0123456789"
const HEADER_VALUE = "header-secret-value-1234"

/** AGENTS.md rule 4: no branch may put a credential-shaped string into `message`. */
function expectNoSecret(message: string): void {
  expect(message).not.toContain(SK_KEY)
  expect(message).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
  expect(message).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/)
  expect(message).not.toContain(HEX_KEY)
  expect(message).not.toContain(HEADER_VALUE)
}

function errorWith(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra)
}

describe("toModelInfraError", () => {
  it("maps 401 to AUTH and redacts the message", () => {
    const raw = `invalid api key ${SK_KEY}`
    const error = toModelInfraError(errorWith(raw, { status: 401 }))

    expect(error.code).toBe("AUTH")
    expect(error.status).toBe(401)
    expect(error.retryable).toBe(false)
    expectNoSecret(error.message)
    // cause keeps the original failure for debug logs
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toBe(raw)
  })

  it("maps 403 and an authentication phrase to AUTH", () => {
    expect(toModelInfraError(errorWith("forbidden", { status: 403 })).code).toBe("AUTH")
    expect(toModelInfraError(errorWith(`unauthorized: ${HEX_KEY}`)).code).toBe("AUTH")
  })

  it("maps 404 and an unknown-model phrase to MODEL_NOT_FOUND", () => {
    const byStatus = toModelInfraError(errorWith("nope", { status: 404 }))
    const byText = toModelInfraError(errorWith(`unknown model ${HEADER_VALUE}`))

    expect(byStatus.code).toBe("MODEL_NOT_FOUND")
    expect(byStatus.retryable).toBe(false)
    expect(byText.code).toBe("MODEL_NOT_FOUND")
    expectNoSecret(byText.message)
  })

  it("maps 429 and quota phrases to RATE_LIMIT", () => {
    const byStatus = toModelInfraError(errorWith("slow down", { status: 429 }))
    const byQuota = toModelInfraError(errorWith(`quota exhausted for ${SK_KEY}`))
    const byCode = toModelInfraError(errorWith("rate limit reached", { code: 429 }))

    expect(byStatus.code).toBe("RATE_LIMIT")
    expect(byStatus.retryable).toBe(true)
    expect(byQuota.code).toBe("RATE_LIMIT")
    expect(byCode.code).toBe("RATE_LIMIT")
    expectNoSecret(byQuota.message)
  })

  it("maps timeouts to TIMEOUT", () => {
    for (const input of [errorWith("late", { status: 408 }), errorWith("late", { status: 504 }), errorWith("ETIMEDOUT")]) {
      const error = toModelInfraError(input)
      expect(error.code).toBe("TIMEOUT")
      expect(error.retryable).toBe(true)
      expectNoSecret(error.message)
    }
  })

  it("maps 400/422 and bad-request phrases to INVALID_REQUEST", () => {
    for (const input of [
      errorWith("bad body", { status: 400 }),
      errorWith("bad body", { status: 422 }),
      errorWith("bad request: malformed tool schema"),
    ]) {
      const error = toModelInfraError(input)
      expect(error.code).toBe("INVALID_REQUEST")
      expect(error.retryable).toBe(false)
      expectNoSecret(error.message)
    }
  })

  it("maps transport failures to CONNECTION", () => {
    for (const raw of ["fetch failed", "ECONNREFUSED 127.0.0.1:1", "socket hang up", "getaddrinfo ENOTFOUND"]) {
      const error = toModelInfraError(errorWith(raw))
      expect(error.code).toBe("CONNECTION")
      expect(error.retryable).toBe(true)
      expectNoSecret(error.message)
    }
  })

  it("maps 5xx to PROVIDER", () => {
    for (const status of [500, 503]) {
      const error = toModelInfraError(errorWith(`upstream blew up with ${SK_KEY}`, { status }))
      expect(error.code).toBe("PROVIDER")
      expect(error.status).toBe(status)
      expect(error.retryable).toBe(true)
      expectNoSecret(error.message)
    }
  })

  it("redacts the upstream text kept by the UNKNOWN fallback (B2)", () => {
    // The exact command from the task card.
    const raw = "upstream said: invalid key sk-abcdefgh12345678 for org"
    const error = toModelInfraError(new Error(raw))

    expect(error.code).toBe("UNKNOWN")
    expect(error.message).toBe("upstream said: invalid key sk-**** for org")
    expectNoSecret(error.message)
    expect(error.cause).toBeInstanceOf(Error)
    expect((error.cause as Error).message).toBe(raw)
  })

  it("redacts Bearer tokens and custom header values in the UNKNOWN fallback", () => {
    const bearer = toModelInfraError(new Error(`proxy echoed Authorization: Bearer ${HEX_KEY}`))
    const header = toModelInfraError(new Error(`upstream echoed x-api-key: ${HEADER_VALUE}`))

    expect(bearer.code).toBe("UNKNOWN")
    expectNoSecret(bearer.message)
    expect(header.code).toBe("UNKNOWN")
    expectNoSecret(header.message)
  })

  it("never leaks a secret from any branch", () => {
    const cases: Array<[ModelInfraErrorCode, unknown]> = [
      ["AUTH", errorWith(`invalid api key ${SK_KEY}`, { status: 401 })],
      ["MODEL_NOT_FOUND", errorWith(`unknown model ${SK_KEY}`, { status: 404 })],
      ["RATE_LIMIT", errorWith(`rate limit ${SK_KEY}`, { status: 429 })],
      ["TIMEOUT", errorWith(`timed out ${SK_KEY}`, { status: 504 })],
      ["INVALID_REQUEST", errorWith(`bad request ${SK_KEY}`, { status: 400 })],
      ["CONNECTION", errorWith(`fetch failed ${SK_KEY}`)],
      ["PROVIDER", errorWith(`server error ${SK_KEY}`, { status: 502 })],
      ["UNKNOWN", errorWith(`mystery failure ${SK_KEY} Bearer ${HEX_KEY}`)],
    ]

    for (const [code, input] of cases) {
      const error = toModelInfraError(input)
      expect(error.code).toBe(code)
      expectNoSecret(error.message)
      expectNoSecret(JSON.stringify(error.toJSON()))
    }
  })

  it("falls back to a stable sentence when the upstream text is empty", () => {
    const error = toModelInfraError(new Error(""))
    expect(error.code).toBe("UNKNOWN")
    expect(error.message).toBe("Unknown provider failure.")
  })

  it("accepts non-Error input and still redacts it", () => {
    const error = toModelInfraError(`string failure ${SK_KEY}`)
    expect(error.code).toBe("UNKNOWN")
    expectNoSecret(error.message)
    expect(error.message).toContain("sk-****")
  })

  it("keeps the context fields on every branch", () => {
    const error = toModelInfraError(errorWith("nope", { status: 401 }), {
      providerId: "openai",
      model: "gpt-4o",
      retryable: true,
    })

    expect(error.providerId).toBe("openai")
    expect(error.model).toBe("gpt-4o")
    // the branch decides retryability, the context cannot force it true for AUTH
    expect(error.retryable).toBe(false)
  })

  it("reads the status from statusCode, response.status and data.statusCode", () => {
    expect(toModelInfraError(errorWith("nope", { statusCode: 404 })).code).toBe("MODEL_NOT_FOUND")
    expect(toModelInfraError(errorWith("nope", { response: { status: 429 } })).code).toBe("RATE_LIMIT")
    expect(toModelInfraError(errorWith("nope", { data: { statusCode: 503 } })).code).toBe("PROVIDER")
  })

  it("returns an existing ModelInfraError untouched", () => {
    const original = new ModelInfraError("already mapped", { code: "STORAGE" })
    expect(toModelInfraError(original)).toBe(original)
    expect(isModelInfraError(original)).toBe(true)
    expect(isModelInfraError(new Error("plain"))).toBe(false)
    expect(isModelInfraError(null)).toBe(false)
  })

  it("serialises without the cause", () => {
    const error = toModelInfraError(new Error(`boom ${SK_KEY}`), { providerId: "openai" })
    const json = error.toJSON()

    expect(json).toMatchObject({ name: "ModelInfraError", code: "UNKNOWN", providerId: "openai", retryable: false })
    expect(Object.hasOwn(json, "cause")).toBe(false)
    expectNoSecret(JSON.stringify(json))
  })
})
