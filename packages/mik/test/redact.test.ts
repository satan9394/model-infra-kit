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

describe("redact — short and unusual secrets (EVO-G05)", () => {
  it("masks a Bearer token regardless of length or charset", () => {
    // Header form: the whole scheme+credential is replaced (header anchored).
    expect(redact("Authorization: Bearer abc")).toBe("Authorization: [REDACTED]")
    expect(redact("authorization: bearer a")).toBe("authorization: [REDACTED]")
    // Bare form outside a header still masks a credential-shaped value.
    expect(redact("Bearer abc123")).toBe("Bearer [REDACTED]")
    expect(redact("Bearer sk-live-1")).toBe("Bearer [REDACTED]")
  })

  it("never masks the prose word that follows a bare 'Bearer'", () => {
    // Regression: an unanchored `(Bearer\\s+)\\S+` rule turned
    // "the Bearer token is required" into "the Bearer [REDACTED] is required".
    expect(redact("the Bearer token is required")).toBe("the Bearer token is required")
    expect(redact("send a Bearer header")).toBe("send a Bearer header")
    expect(redact("Bearer auth scheme")).toBe("Bearer auth scheme")
    // …while a query parameter that may really carry a token is still masked.
    expect(redact("GET /api/keys?token=1")).toBe("GET /api/keys?token=[REDACTED]")
  })

  it("masks other Authorization schemes, whose credentials are base64 secrets", () => {
    // Regression: the key=value rule used to mask the word "Basic" and leave the
    // base64 `user:password` untouched.
    const basic = redact("Authorization: Basic dXNlcjpwYXNz")
    expect(basic).toBe("Authorization: [REDACTED]")
    expect(basic).not.toContain("dXNlcjpwYXNz")
    expect(redact("authorization: digest abc123")).toBe("authorization: [REDACTED]")
    expect(redact("Authorization: Token short")).toBe("Authorization: [REDACTED]")
  })

  it("masks non-enumerated schemes and quoted (JSON) header keys", () => {
    // S1 (EVO-G05 review): enumerating schemes leaks every scheme we forgot, and a
    // quoted JSON key used to defeat the separator match entirely.
    expect(redact("Authorization: ApiKey abc123")).toBe("Authorization: [REDACTED]")
    expect(redact("Authorization: Negotiate TlRMTVNTUAAB")).toBe("Authorization: [REDACTED]")
    const json = redact('{"authorization": "Basic dXNlcjpwYXNz"}')
    expect(json).not.toContain("dXNlcjpwYXNz")
    expect(json).toContain('"authorization": "[REDACTED]"')
  })

  it("masks a one-character key=value secret", () => {
    expect(redact("token=x")).toBe("token=[REDACTED]")
    expect(redact("api_key=k")).toBe("api_key=[REDACTED]")
  })

  it("masks values containing +, / and = (base64-shaped)", () => {
    expect(redact("api_key=ab+/=")).toBe("api_key=[REDACTED]")
    expect(redact("secret=YWJj+/==")).toBe("secret=[REDACTED]")
  })

  it("masks a Unicode secret value", () => {
    const output = redact("secret=密钥值")
    expect(output).not.toContain("密钥值")
    expect(output).toContain("[REDACTED]")
  })

  it("masks short keys that carry a known prefix", () => {
    expect(redact("used sk-ab")).toBe("used sk-****")
    expect(redact("used ghp_x")).toBe("used ghp_****")
    expect(redact("used tvly-1")).toBe("used tvly-****")
  })

  it("does not over-redact prose that merely mentions a secret word", () => {
    // No `=`/`:` separator and no known prefix: nothing may be masked.
    expect(redact("token counts are 12")).toBe("token counts are 12")
    expect(redact("the token budget is 5 and secret handling is fine")).toBe(
      "the token budget is 5 and secret handling is fine",
    )
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
