import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  EMBED_MESSAGE,
  buildErrorMessage,
  buildReadyMessage,
  buildResizeMessage,
  containsSensitiveKeys,
  embedContentSize,
  isTrustedOrigin,
  normalizeOrigin,
  parseAllowedOrigins,
  validateHostMessage,
} from "../lib/embed-bridge.ts"

const HOST = "https://host.example"
const EMBED = "https://embed.example"
const context = { origin: HOST, allowedOrigins: [HOST], selfOrigin: EMBED }

test("normalizeOrigin keeps real origins and refuses wildcards and opaque values", () => {
  assert.equal(normalizeOrigin("https://Host.EXAMPLE"), "https://host.example")
  assert.equal(normalizeOrigin("https://host.example:443"), "https://host.example")
  assert.equal(normalizeOrigin("http://host.example:80/path?x=1"), "http://host.example")
  assert.equal(normalizeOrigin("  https://host.example  "), "https://host.example")
  assert.equal(normalizeOrigin("*"), null)
  assert.equal(normalizeOrigin("null"), null)
  assert.equal(normalizeOrigin(""), null)
  assert.equal(normalizeOrigin("host.example"), null)
  assert.equal(normalizeOrigin("file:///etc/passwd"), null)
  assert.equal(normalizeOrigin(42), null)
  assert.equal(normalizeOrigin(null), null)
})

test("parseAllowedOrigins splits, normalises and drops duplicates and the wildcard", () => {
  assert.deepEqual(parseAllowedOrigins("https://a.example, https://A.example, *"), ["https://a.example"])
  assert.deepEqual(parseAllowedOrigins(" https://b.example ,not a url:,https://c.example "), [
    "https://b.example",
    "https://c.example",
  ])
  assert.deepEqual(parseAllowedOrigins("*"), [])
  assert.deepEqual(parseAllowedOrigins(undefined), [])
})

test("an origin is trusted only when it is the embed itself or explicitly allowed", () => {
  assert.equal(isTrustedOrigin(EMBED, [], EMBED), true)
  assert.equal(isTrustedOrigin(HOST, [HOST], EMBED), true)
  assert.equal(isTrustedOrigin("https://evil.example", [HOST], EMBED), false)
  assert.equal(isTrustedOrigin("https://evil.example", ["*"], EMBED), false)
  assert.equal(isTrustedOrigin("*", [HOST], EMBED), false)
})

test("a valid handshake is accepted and normalised without leaking extra fields", () => {
  const result = validateHostMessage(
    { type: EMBED_MESSAGE.INIT, targetOrigin: "https://Host.example/", theme: "dark", dateRange: "7d" },
    context,
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.origin, HOST)
  assert.deepEqual(result.message, {
    type: EMBED_MESSAGE.INIT,
    targetOrigin: HOST,
    theme: "dark",
    dateRange: "7d",
  })
  assert.deepEqual(Object.keys(result.message).sort(), ["dateRange", "targetOrigin", "theme", "type"])
})

test("a host cannot hand over a targetOrigin that is not its own origin", () => {
  const mismatch = validateHostMessage(
    { type: EMBED_MESSAGE.INIT, targetOrigin: "https://evil.example" },
    context,
  )
  assert.equal(mismatch.ok, false)
  if (!mismatch.ok) assert.equal(mismatch.reason, "target")

  const wildcard = validateHostMessage({ type: EMBED_MESSAGE.INIT, targetOrigin: "*" }, context)
  assert.equal(wildcard.ok, false)
  if (!wildcard.ok) assert.equal(wildcard.reason, "target")
})

test("a message from an off-allow-list origin is dropped, never replied to", () => {
  for (const origin of ["https://evil.example", "*", "null", ""]) {
    const result = validateHostMessage(
      { type: EMBED_MESSAGE.INIT, targetOrigin: origin },
      { allowedOrigins: [HOST], selfOrigin: EMBED, origin },
    )
    assert.equal(result.ok, false, origin)
    if (!result.ok) assert.equal(result.reason, "origin")
  }
})

test("after negotiation only the negotiated origin may keep talking", () => {
  const result = validateHostMessage(
    { type: EMBED_MESSAGE.SET_THEME, theme: "light" },
    { origin: "https://other.example", allowedOrigins: [HOST, "https://other.example"], selfOrigin: EMBED, negotiatedOrigin: HOST },
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, "negotiated-origin")
})

test("malformed and sensitive messages are rejected as a whole", () => {
  const bad: Array<[unknown, string]> = [
    [null, "shape"],
    ["MIK_EMBED_INIT", "shape"],
    [[{ type: EMBED_MESSAGE.INIT }], "shape"],
    [{}, "shape"],
    [{ type: 5 }, "shape"],
    [{ type: "MIK_EMBED_MONITOR" }, "shape"],
    [{ type: EMBED_MESSAGE.RESIZE, height: 10 }, "shape"],
    [{ type: EMBED_MESSAGE.INIT, targetOrigin: HOST, theme: "blue" }, "payload"],
    [{ type: EMBED_MESSAGE.INIT, targetOrigin: HOST, dateRange: 5 }, "payload"],
    [{ type: EMBED_MESSAGE.INIT, targetOrigin: HOST, dateRange: "90d" }, "payload"],
    [{ type: EMBED_MESSAGE.INIT, targetOrigin: HOST, dateRange: "custom" }, "payload"],
    [{ type: EMBED_MESSAGE.INIT, targetOrigin: HOST, dateRange: "x".repeat(65) }, "payload"],
    [{ type: EMBED_MESSAGE.SET_THEME, theme: "purple" }, "payload"],
    [{ type: EMBED_MESSAGE.SET_THEME }, "payload"],
    [{ type: EMBED_MESSAGE.INIT, targetOrigin: HOST, token: "sk-live" }, "sensitive"],
    [{ type: EMBED_MESSAGE.INIT, targetOrigin: HOST, metadata: { api_key: "x" } }, "sensitive"],
    [{ type: EMBED_MESSAGE.SET_THEME, theme: "dark", authorization: "Bearer x" }, "sensitive"],
  ]
  for (const [data, reason] of bad) {
    const result = validateHostMessage(data, context)
    assert.equal(result.ok, false, JSON.stringify(data))
    if (!result.ok) assert.equal(result.reason, reason, JSON.stringify(data))
  }
})

test("theme switching is accepted only from the trusted origin", () => {
  const ok = validateHostMessage({ type: EMBED_MESSAGE.SET_THEME, theme: "light" }, context)
  assert.deepEqual(ok, { ok: true, origin: HOST, message: { type: EMBED_MESSAGE.SET_THEME, theme: "light" } })
})

test("sensitive key detection looks through nested objects and arrays", () => {
  assert.equal(containsSensitiveKeys({ nested: { list: [{ password: "x" }] } }), true)
  assert.equal(containsSensitiveKeys({ theme: "dark", dateRange: "7d" }), false)
  assert.equal(containsSensitiveKeys({ country: "NL" }), false)
})

test("outbound frames carry only non-sensitive numbers and a version", () => {
  assert.deepEqual(buildReadyMessage(), { type: EMBED_MESSAGE.READY, version: "1.0" })
  assert.deepEqual(buildResizeMessage(412.4, -3), { type: EMBED_MESSAGE.RESIZE, height: 412, width: 0 })
  assert.deepEqual(buildResizeMessage(Number.NaN, Number.POSITIVE_INFINITY), {
    type: EMBED_MESSAGE.RESIZE,
    height: 0,
    width: 0,
  })
  const error = buildErrorMessage("origin", "x".repeat(500))
  assert.equal(error.type, EMBED_MESSAGE.ERROR)
  assert.equal(error.message.length, 200)
})

test("embedContentSize reports the largest box so the host never adds an inner scrollbar", () => {
  assert.deepEqual(
    embedContentSize(
      { scrollHeight: 100, offsetHeight: 90, clientWidth: 50, scrollWidth: 60 },
      { scrollHeight: 120, offsetHeight: 110, clientWidth: 55, scrollWidth: 70 },
    ),
    { height: 120, width: 70 },
  )
  assert.deepEqual(
    embedContentSize({ scrollHeight: 0, offsetHeight: 0, clientWidth: 0, scrollWidth: 0 }, null),
    { height: 0, width: 0 },
  )
})

test("the bridge source never posts to a wildcard and always wires ResizeObserver + message", () => {
  const bridge = readFileSync(new URL("../lib/embed-bridge.ts", import.meta.url), "utf8")
  const shell = readFileSync(new URL("../components/embed-shell.tsx", import.meta.url), "utf8")
  for (const [name, source] of [["embed-bridge", bridge], ["embed-shell", shell]] as const) {
    assert.doesNotMatch(source, /postMessage\([^)]*,\s*["'`]\*["'`]/, name)
  }
  assert.match(shell, /addEventListener\("message"/)
  assert.match(shell, /removeEventListener\("message"/)
  assert.match(shell, /new ResizeObserver\(/)
  assert.match(shell, /observer\.disconnect\(\)/)
  assert.match(shell, /window\.parent\.postMessage\([^)]*,\s*target\)/)
  // A trusted host learns *why* a malformed frame failed; an untrusted origin is
  // never answered (the branch is guarded by the two origin reasons above it).
  assert.match(shell, /buildErrorMessage\(result\.reason\)/)
  assert.match(shell, /result\.reason !== "origin" && result\.reason !== "negotiated-origin"/)
  // A page that is not framed must not answer its own messages on the error channel.
  assert.match(shell, /event\.source !== window/)
  // The handshake's dateRange is applied, not silently dropped.
  assert.match(shell, /url\.searchParams\.set\("range", message\.dateRange\)/)
})
