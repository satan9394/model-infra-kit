import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CredentialStore } from "../src/credential/store.js"
import { ModelInfraError } from "../src/errors.js"
import { ModelInfra, type ModelInfraOptions } from "../src/hub.js"

/**
 * ARCH-011 (EVO-G146) — lifecycle resilience.
 *
 * Two promises the architecture plan makes about startup and secrets:
 *
 *   1. an unreachable price catalogue or model directory degrades through
 *      `onWarn`; `ModelInfra.init()` still returns and the hub is usable;
 *   2. a credential that cannot be resolved produces a *de-sensitised*
 *      diagnosis — never the secret value, and (since EVO-G146) never the
 *      filesystem path either.
 *
 * The second promise is asserted against literal expected strings, not against
 * the masking helper, so a change to the helper cannot make the test pass by
 * mirroring itself (see AGENTS.md 复盘 R208/R231).
 */

/** No test may reach the network. */
const offlineFetch = (async () => {
  throw new Error("network disabled in tests")
}) as unknown as typeof globalThis.fetch

const dirs: string[] = []
const hubs: ModelInfra[] = []
let warnings: string[] = []
let cacheDir = ""

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mik-g146-life-"))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  warnings = []
  cacheDir = tempDir()
})

afterEach(async () => {
  while (hubs.length > 0) await hubs.pop()?.close()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

async function makeHub(options: ModelInfraOptions = {}): Promise<ModelInfra> {
  const hub = await ModelInfra.init({
    appId: "g146-life",
    db: ":memory:",
    cacheDir,
    pricingFetch: offlineFetch,
    syncCatalog: false,
    maxRetries: 0,
    onWarn: (message) => warnings.push(String(message)),
    ...options,
  })
  hubs.push(hub)
  return hub
}

describe("ARCH-011 — offline startup degrades instead of failing", () => {
  it("init() resolves against an unreachable catalogue and the hub still records usage", { timeout: 30_000 }, async () => {
    const hub = await makeHub({
      syncCatalog: true,
      providers: [{ id: "offline", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", enabled: true }],
    })

    // The catalogue never loaded, but that is a state, not a crash.
    expect(hub.pricing.state().status).not.toBe("fresh")
    expect(hub.usage.record({
      requestId: "offline-1",
      appId: "g146-life",
      ts: Date.now(),
      source: "test",
      providerId: "offline",
      modelRequested: "m",
      modelActual: "m",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: { usd: 0, low: 0, high: 0, basis: "unknown", source: "missing" },
      status: "ok",
      isStreaming: false,
    })).toBe(true)
    expect(hub.usage.summary().requests).toBe(1)

    // The background directory sync settles quietly rather than rejecting.
    await expect(hub.catalogSync).resolves.toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.every((message) => typeof message === "string")).toBe(true)
  })

  it("pricing.refresh() reports the failure through onWarn and never rejects", { timeout: 30_000 }, async () => {
    const hub = await makeHub()
    const result = await hub.pricing.refresh()
    // The catalogue keeps answering from the bundled archive, so the state is
    // stale/error rather than fresh — but the call itself must not throw.
    expect(result.status).not.toBe("fresh")
    expect(hub.pricing.state().status).not.toBe("fresh")
    expect(warnings.join("\n")).toMatch(/failed to load|modelsdev|pricing catalogue/i)
  })

  it("survives a provider whose credential cannot resolve, and reports it through the public API", { timeout: 30_000 }, async () => {
    const missing = join(tempDir(), "owner-secret-segment", "missing-key")
    const hub = await makeHub({
      providers: [{ id: "bad", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", apiKeyRef: `file:${missing}`, enabled: true }],
      defaultModel: "bad:m",
    })

    // init() itself is lazy: a bad credential is not a startup failure.
    expect(() => hub.providers.resolve("bad")).toThrowError(ModelInfraError)
    let failure: ModelInfraError | undefined
    try {
      await hub.generate({ model: "bad:m", messages: [{ role: "user", content: "hi" }] })
    } catch (error) {
      failure = error as ModelInfraError
    }
    expect(failure).toBeInstanceOf(ModelInfraError)
    expect(failure!.code).toBe("CREDENTIAL")
    // The same de-sensitisation must hold on the hub's own error surface.
    expect(failure!.message).not.toContain("owner-secret-segment")
    expect(failure!.message).not.toContain(missing)
  })
})

describe("ARCH-011 — credential diagnostics are de-sensitised", () => {
  it("masks a malformed reference instead of echoing it", () => {
    const store = new CredentialStore()
    let failure: ModelInfraError | undefined
    try {
      store.parse("sk-live-abcdef1234567890")
    } catch (error) {
      failure = error as ModelInfraError
    }
    expect(failure).toBeInstanceOf(ModelInfraError)
    expect(failure!.code).toBe("CREDENTIAL")
    expect(failure!.message).not.toContain("sk-live-abcdef1234567890")
    expect(failure!.message).not.toContain("abcdef1234567890")
    expect(failure!.message).toContain("sk-l****90")
  })

  it("never discloses the filesystem path of a missing credential file", () => {
    // The segment is deliberately distinctive so an accidental echo is caught.
    const path = join(tempDir(), "owner-secret-segment", "missing-key")
    const store = new CredentialStore()
    let failure: ModelInfraError | undefined
    try {
      store.resolve(`file:${path}`)
    } catch (error) {
      failure = error as ModelInfraError
    }
    expect(failure).toBeInstanceOf(ModelInfraError)
    expect(failure!.code).toBe("CREDENTIAL")
    expect(failure!.message).not.toContain("owner-secret-segment")
    expect(failure!.message).not.toContain("missing-key")
    expect(failure!.message).not.toContain(path)
    expect(failure!.message).toContain("Credential file not found")
  })

  it("never discloses the path of an empty credential file", () => {
    const dir = tempDir()
    const parent = join(dir, "owner-secret-segment")
    const path = join(parent, "blank-key")
    mkdirSync(parent, { recursive: true })
    writeFileSync(path, "   \n")
    const store = new CredentialStore()
    let failure: ModelInfraError | undefined
    try {
      store.resolve(`file:${path}`)
    } catch (error) {
      failure = error as ModelInfraError
    }
    expect(failure).toBeInstanceOf(ModelInfraError)
    expect(failure!.message).not.toContain("owner-secret-segment")
    expect(failure!.message).not.toContain("blank-key")
    expect(failure!.message).toContain("Credential file is empty")
  })

  it("names a missing environment variable but never its value", () => {
    const secret = "sk-env-secret-value-9876543210"
    const store = new CredentialStore({ env: { MIK_G146_SET_KEY: secret } })
    // The variable IS set here, so resolve succeeds and the value never enters a message.
    expect(store.resolve("env:MIK_G146_SET_KEY")).toBe(secret)

    let failure: ModelInfraError | undefined
    try {
      store.resolve("env:MIK_G146_DEFINITELY_MISSING")
    } catch (error) {
      failure = error as ModelInfraError
    }
    expect(failure).toBeInstanceOf(ModelInfraError)
    expect(failure!.message).toContain("MIK_G146_DEFINITELY_MISSING")
    expect(failure!.message).not.toContain(secret)
  })

  it("keeps the keychain diagnostic free of any location", () => {
    let failure: ModelInfraError | undefined
    try {
      new CredentialStore().resolve("keychain:owner-secret-segment")
    } catch (error) {
      failure = error as ModelInfraError
    }
    expect(failure).toBeInstanceOf(ModelInfraError)
    expect(failure!.message).not.toContain("owner-secret-segment")
    expect(failure!.message).toContain("not implemented")
  })
})
