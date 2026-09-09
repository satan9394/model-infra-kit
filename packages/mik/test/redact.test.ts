import { describe, expect, it } from "vitest"
import { maskSecret, redact, redactDeep } from "../src/util/redact.js"

const SK_KEY = "sk-abcdefgh12345678"
const HEX_KEY = "0123456789abcdef0123456789abcdef"

/** Every key shape the task card names, plus the close variants it mentions. */
const SECRET_KEYS = [
  "authorization",
  "Authorization",
  "api-key",
  "x-api-key",
  "X-Api-Key",
  "API_KEY",
  "apiKey",
  "openai-api-key",
  "x-goog-api-key",
  "x-auth-token",
  "access_token",
  "client-secret",
  "password",
  "Cookie",
  "set-cookie",
]

/** Keys that merely *contain* a fragment but never carry a secret. */
const SAFE_KEYS = ["id", "model", "baseUrl", "apiKeyRef", "inputTokens", "totalTokens", "maxOutputTokens", "tokenCount"]

describe("redact", () => {
  it("masks sk- keys inside upstream text", () => {
    expect(redact(`upstream said: invalid key ${SK_KEY} for org`)).toBe("upstream said: invalid key sk-**** for org")
  })

  it("masks the other known key prefixes", () => {
    expect(redact(`search failed: tvly-abcdefgh12345678`)).toBe("search failed: tvly-****")
    expect(redact(`git push used ghp_abcdefgh12345678`)).toBe("git push used ghp_****")
    expect(redact(`aws key AKIAabcdefgh12345678`)).toBe("aws key AKIA****")
  })

  it("masks a Bearer token even when it is not a known prefix", () => {
    const output = redact(`Authorization: Bearer ${HEX_KEY}`)

    expect(output).not.toContain(HEX_KEY)
    expect(output).toContain("[REDACTED]")
  })

  it("masks key=value and key: value pairs", () => {
    expect(redact(`api_key=${HEX_KEY}`)).toBe("api_key=[REDACTED]")
    expect(redact(`token: ${HEX_KEY}`)).toBe("token: [REDACTED]")
    expect(redact(`secret="${HEX_KEY}"`)).toBe('secret="[REDACTED]"')
    expect(redact(`x-api-key: ${HEX_KEY}`)).toBe("x-api-key: [REDACTED]")
  })

  it("leaves ordinary text untouched", () => {
    expect(redact("model deepseek-chat answered in 320 ms")).toBe("model deepseek-chat answered in 320 ms")
    expect(redact("")).toBe("")
  })
})

describe("maskSecret", () => {
  it("keeps only the last four characters", () => {
    expect(maskSecret(SK_KEY)).toBe("****5678")
  })

  it("masks short secrets completely", () => {
    expect(maskSecret("abcd")).toBe("****")
    expect(maskSecret("")).toBe("****")
  })
})

describe("redactDeep", () => {
  it("replaces every secret-named key, prefixed headers included (S7)", () => {
    for (const key of SECRET_KEYS) {
      const output = redactDeep({ [key]: HEX_KEY }) as Record<string, string>
      expect(output[key], key).toBe("[REDACTED]")
    }
  })

  it("keeps keys that only look secret-adjacent", () => {
    const input = Object.fromEntries(SAFE_KEYS.map((key) => [key, key === "apiKeyRef" ? "env:FOO" : 42]))
    expect(redactDeep(input)).toEqual(input)
  })

  it("masks a custom header value in a nested provider list", () => {
    const value = { providers: [{ id: "openai", headers: { "x-api-key": HEX_KEY } }] }
    const output = redactDeep(value)

    expect(JSON.stringify(output)).not.toContain(HEX_KEY)
    expect(output.providers[0]?.headers["x-api-key"]).toBe("[REDACTED]")
    expect(output.providers[0]?.id).toBe("openai")
  })

  it("recurses into arrays and redacts secret-shaped strings inside them", () => {
    expect(redactDeep([SK_KEY, "plain"])).toEqual(["sk-****", "plain"])
    expect(redactDeep({ notes: [SK_KEY] })).toEqual({ notes: ["sk-****"] })
    expect(redactDeep({ "set-cookie": ["a=1", "b=2"] })).toEqual({ "set-cookie": "[REDACTED]" })
  })

  it("preserves token counts stored under container keys", () => {
    const event = { usage: { input: 1200, output: 300 }, tokens: { input: 1200, output: 300 }, prompt_tokens: 1500 }
    expect(redactDeep(event)).toEqual(event)
  })

  it("passes primitives through untouched", () => {
    expect(redactDeep(42)).toBe(42)
    expect(redactDeep(true)).toBe(true)
    expect(redactDeep(null)).toBeNull()
    expect(redactDeep(undefined)).toBeUndefined()
  })

  it("does not mutate the input", () => {
    const input = { id: "openai", headers: { "x-api-key": HEX_KEY } }
    const output = redactDeep(input)

    expect(input.headers["x-api-key"]).toBe(HEX_KEY)
    expect(output).not.toBe(input)
    expect(output.headers).not.toBe(input.headers)
  })

  it("stops at the depth limit without leaking the leaf", () => {
    let deep: Record<string, unknown> = { "x-api-key": HEX_KEY }
    for (let index = 0; index < 8; index += 1) deep = { nested: deep }

    const serialized = JSON.stringify(redactDeep(deep))
    expect(serialized).toContain("[depth-limit]")
    expect(serialized).not.toContain(HEX_KEY)
  })
})
