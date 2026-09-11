#!/usr/bin/env node
/**
 * `scripts/e2e/run.mjs` — one command, every acceptance scenario.
 *
 * Walks `docs/SPEC.md` §6 and `tasks/T09-examples-e2e.md` end to end against a
 * local mock provider. Nothing here touches the public internet: the mock
 * provider is an HTTP server on 127.0.0.1, and the price catalogue is pinned to
 * an unreachable URL so its bundled archive has to answer (that is scenario 6).
 *
 *   node scripts/e2e/run.mjs
 *
 * Exit code 0 = every check passed. A failing check prints a FAIL line, the run
 * keeps going so the whole list is visible, and the process exits non-zero.
 *
 * Flags:
 *   --inject-failure    deliberately fail the first check (proves the exit code)
 *   --break-dashboard   point the dashboard at an unreachable `mik serve`
 *                       (proves the DASH check asserts live numbers, not markup)
 *
 * The temporary directory is left in `.tmp/e2e-<timestamp>/` on purpose: it holds
 * the SQLite database and the CLI config that produced the numbers, which is
 * what makes a failure reproducible. `.tmp/` is git-ignored.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { formatCompact, formatInt, formatRate, formatUsd, tokenTotal } from "../../apps/dashboard/lib/format.ts"
import { MOCK_MODELS, startMockProvider } from "./mock-provider.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..", "..")
const LOADER = join(HERE, "loader.mjs")
/** `--import` wants a specifier or URL, not a Windows path. */
const LOADER_URL = pathToFileURL(LOADER).href
const CLI_ENTRY = join(ROOT, "packages", "mik", "src", "cli", "index.ts")
/** The published artifact: what `npm pack` ships, and what DASH/DIST check. */
const DIST_CLI = join(ROOT, "packages", "mik", "dist", "cli.mjs")
const DASHBOARD_DIR = join(ROOT, "apps", "dashboard")
const DASHBOARD_NEXT = join(DASHBOARD_DIR, "node_modules", "next", "dist", "bin", "next")
const OPENAI_SDK_EXAMPLE = join(ROOT, "examples", "openai-sdk", "index.ts")
const CLI_AGENT_EXAMPLE = join(ROOT, "examples", "cli-agent", "index.ts")
const PYTHON_EXAMPLE = join(ROOT, "examples", "python-host", "host.py")
/**
 * Portable python resolution, in order:
 *   MIK_E2E_PYTHON → `python3` (or `python`) found on PATH → bare "python3".
 * The old default hard-coded a Windows Anaconda path, which broke CI runners.
 */
function resolvePython() {
  const fromEnv = process.env.MIK_E2E_PYTHON
  if (fromEnv) return fromEnv
  for (const name of ["python3", "python"]) {
    const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8" })
    if (found.status === 0) {
      const first = (found.stdout || "").trim().split(/\r?\n/)[0]
      if (first) return first
    }
    // The name may still run via PATH lookup even if `which` missed it.
    const probe = spawnSync(name, ["--version"], { encoding: "utf8" })
    if (probe.status === 0) return name
  }
  return "python3"
}
const PYTHON = resolvePython()
const TRANSFORM_FLAG = "--experimental-transform-types"
/** Every Node child needs the source loader; TS parameter properties need the transform flag. */
const NODE_FLAGS = [TRANSFORM_FLAG, "--disable-warning=ExperimentalWarning", "--import", LOADER_URL]

const argv = process.argv.slice(2)
const injectFailure = argv.includes("--inject-failure")
const breakDashboard = argv.includes("--break-dashboard")
const APP_ID = "mik-e2e"
/** G01: the e2e proxy server needs a token now — write endpoints 401 without one. */
const SERVER_TOKEN = "e2e-write-token"
const DEFAULT_PORT = 3211
const DASHBOARD_PORT = 3210
const DIST_PORT = 3212
/** Nothing listens on port 1: the dashboard's "upstream is down" path. */
const DEAD_SERVER_URL = "http://127.0.0.1:1"

// ───────────────────────────────── plumbing ─────────────────────────────────

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function closeTo(actual, expected, tolerance = 1e-12) {
  return typeof actual === "number" && Math.abs(actual - expected) <= tolerance
}

/** The child environment: no proxy, no ambient mik configuration, local calls direct. */
function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "MIK_OFFLINE",
    "MIK_DB",
    "MIK_APP_ID",
    "MIK_CONFIG",
    "MIK_EXAMPLE_ONLINE_PRICING",
  ]) {
    delete env[key]
  }
  env.NO_PROXY = "127.0.0.1,localhost"
  env.no_proxy = "127.0.0.1,localhost"
  // The harness is a tool, not a user: pin its language so the assertions below
  // never depend on the machine's OS locale (a zh-CN host would otherwise render
  // Chinese and flip the English help assertions). EVO-G12/G26.
  env.MIK_LANG = "en"
  return { ...env, ...extra }
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? cleanEnv(),
      cwd: options.cwd ?? ROOT,
      shell: options.shell === true,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}${messageOf(error)}` }))
    child.on("exit", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }))
  })
}

const runNode = (args, options) => spawnCapture(process.execPath, [...NODE_FLAGS, ...args], options)
const runCli = (args, options) => runNode([CLI_ENTRY, ...args], options)
/** pnpm is a `.cmd` shim on Windows, which `spawn` only runs through a shell. */
const runPnpm = (args, options) =>
  spawnCapture(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { ...options, shell: process.platform === "win32" })

async function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const server = createNetServer()
    server.once("error", () => resolvePromise(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)))
  })
}

async function ephemeralPort() {
  return new Promise((resolvePromise, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolvePromise(port))
    })
  })
}

async function pickPort(preferred) {
  if (await isPortFree(preferred)) return { port: preferred, note: `${preferred} (the project convention, verified free)` }
  const port = await ephemeralPort()
  return { port, note: `${port} (convention port ${preferred} was busy, so an ephemeral port was used)` }
}

async function getJson(url, timeoutMs = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return { status: response.status, body: await response.json() }
}

async function getHtml(url, timeoutMs = 30_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return { status: response.status, body: await response.text() }
}

/**
 * React separates interpolated text with `<!-- -->`, so `pricing {status}`
 * arrives as `pricing <!-- -->stale`. Strip the markers before matching.
 */
function plainText(html) {
  return html.replace(/<!--.*?-->/g, "").replace(/\s+/g, " ")
}

/** Wait until a page renders (the dashboard compiles/starts lazily). */
async function waitForPage(origin, path = "/", timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last = "no response"
  while (Date.now() < deadline) {
    try {
      const { status } = await getHtml(`${origin}${path}`, 10_000)
      if (status === 200) return
      last = `HTTP ${status}`
    } catch (error) {
      last = messageOf(error)
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error(`${origin}${path} did not answer 200 within ${timeoutMs} ms (${last})`)
}

/** Newest mtime under a directory, ignoring build output and generated files. */
function newestMtime(directory) {
  let newest = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      // `.next` and `node_modules` are output; `*.tsbuildinfo` and
      // `next-env.d.ts` are written by the toolchain, not by a human.
      if (/(node_modules|\.next|\.tmp|\.tsbuildinfo$|next-env\.d\.ts$)/.test(full)) continue
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      try {
        newest = Math.max(newest, statSync(full).mtimeMs)
      } catch {}
    }
  }
  walk(directory)
  return newest
}

/** `next start` needs a build; rebuild only when it is missing or stale. */
async function ensureDashboardBuild() {
  const buildId = join(DASHBOARD_DIR, ".next", "BUILD_ID")
  if (existsSync(buildId)) {
    try {
      if (statSync(buildId).mtimeMs >= newestMtime(DASHBOARD_DIR)) return "reused .next (newer than every source file)"
    } catch {}
  }
  const build = await runPnpm(["--filter", "@mik/dashboard", "build"])
  assert(build.code === 0, `pnpm --filter @mik/dashboard build exited ${build.code}\n${build.stdout.slice(-2000)}\n${build.stderr.slice(-2000)}`)
  assert(existsSync(buildId), "the dashboard build finished without writing .next/BUILD_ID")
  return "built .next (it was missing or older than the sources)"
}

/** Start the dashboard exactly the way `mik dashboard` does: `next start`. */
function startDashboard(port, serverUrl) {
  assert(existsSync(DASHBOARD_NEXT), `next is not installed at ${DASHBOARD_NEXT} — run \`pnpm install\` first`)
  const child = spawn(process.execPath, [DASHBOARD_NEXT, "start", "-p", String(port)], {
    cwd: DASHBOARD_DIR,
    env: cleanEnv({
      MIK_SERVER_URL: serverUrl,
      MIK_SERVER_TOKEN: SERVER_TOKEN,
      PORT: String(port),
      NODE_ENV: "production",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  return { child, output: () => output }
}

async function waitForHealth(origin, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = "no response"
  while (Date.now() < deadline) {
    try {
      const { status, body } = await getJson(`${origin}/api/health`, 2000)
      if (status === 200) return body
      last = `HTTP ${status}`
    } catch (error) {
      last = messageOf(error)
    }
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error(`the server did not answer /api/health within ${timeoutMs} ms (${last})`)
}

/** Stop a child and make sure its port really came back. */
async function stopChild(child, label, port) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((done) => child.once("exit", done))
  child.kill()
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
  if (port !== undefined) {
    assert(await isPortFree(port), `${label} still holds port ${port} after being stopped`)
  }
}

// ────────────────────────────── the checks ──────────────────────────────────

const checks = []
let current = null

function startCheck(id, title) {
  current = { id, title, ok: false, detail: "", numbers: {} }
  checks.push(current)
  process.stdout.write(`\n[${id}] ${title}\n`)
}

function pass(detail, numbers = {}) {
  current.ok = true
  current.detail = detail
  Object.assign(current.numbers, numbers)
  process.stdout.write(`  PASS  ${detail}\n`)
}

async function step(id, title, body) {
  startCheck(id, title)
  if (injectFailure && id !== "AC1") {
    current.detail = "skipped: --inject-failure runs stop after the first check"
    process.stdout.write(`  FAIL  ${current.detail}\n`)
    return
  }
  try {
    await body()
  } catch (error) {
    current.ok = false
    current.detail = messageOf(error)
    process.stdout.write(`  FAIL  ${current.detail}\n`)
  }
}

/** The offline transport every scenario uses: the bundled archive has to answer. */
async function unreachableFetch() {
  throw new Error("e2e: outbound network is disabled")
}

async function main() {
  const startedAt = Date.now()
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const tmpRoot = join(ROOT, ".tmp", `e2e-${stamp}`)
  const dbPath = join(tmpRoot, "usage.db")
  const configPath = join(tmpRoot, "mik.config.json")
  /** A cold cache dir: the price catalogue must fall back to its bundled archive. */
  const cacheDir = join(tmpRoot, "cache")
  mkdirSync(tmpRoot, { recursive: true })

  const { ModelInfra } = await import("model-infra-kit")
  const { createServer } = await import("model-infra-kit/server")
  const { PricingCatalog } = await import("llm-pricing")

  const cleanup = []
  const numbers = {}
  let exitCode = 1

  process.stdout.write("model-infra-kit · end-to-end acceptance (docs/SPEC.md §6)\n")
  process.stdout.write(`  repo      ${ROOT}\n`)
  process.stdout.write(`  temp dir  ${tmpRoot}\n`)
  process.stdout.write(`  database  ${dbPath}\n`)
  process.stdout.write("  network   none: mock provider on 127.0.0.1, price catalogue pointed at an unreachable URL\n")

  const mock = await startMockProvider()
  cleanup.push(async () => mock.close())
  process.stdout.write(`  mock      ${mock.url} (${MOCK_MODELS.length} models)\n`)

  const { port: proxyPort, note: portNote } = await pickPort(DEFAULT_PORT)
  process.stdout.write(`  proxy     http://127.0.0.1:${proxyPort} — ${portNote}\n`)

  try {
    // ───────────────────────── AC1 ─────────────────────────
    await step("AC1", "fresh temp dir + temp db: `mik init` then boot with no provider", async () => {
      if (injectFailure) {
        throw new Error("injected failure: this run exists only to prove a failing check exits non-zero")
      }
      assert(!existsSync(dbPath), `the temporary database ${dbPath} already exists`)

      const init = await runCli(["init", "--offline",
        "--cache-dir",
        cacheDir, "--yes", "--app-id", APP_ID, "--db", dbPath, "--file", configPath])
      assert(init.code === 0, `mik init exited ${init.code}\n${init.stdout}\n${init.stderr}`)
      assert(existsSync(configPath), "mik init did not write the config file")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      assert(config.appId === APP_ID, `config appId is ${config.appId}`)
      assert(config.db === dbPath, `config db is ${config.db}`)

      const list = await runCli(["provider", "list", "--offline",
        "--cache-dir",
        cacheDir, "--config", configPath])
      assert(list.code === 0, `mik provider list exited ${list.code}\n${list.stderr}`)
      assert(list.stdout.includes("No providers configured."), "mik provider list did not report an empty registry")

      // Boot the real CLI server with zero providers configured.
      const serve = spawn(
        process.execPath,
        [...NODE_FLAGS, CLI_ENTRY, "serve", "--offline",
        "--cache-dir",
        cacheDir, "--config", configPath, "--port", String(proxyPort)],
        { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(), cwd: ROOT },
      )
      let serveOut = ""
      serve.stdout.on("data", (chunk) => (serveOut += chunk))
      serve.stderr.on("data", (chunk) => (serveOut += chunk))
      try {
        const health = await waitForHealth(`http://127.0.0.1:${proxyPort}`)
        assert(health.status === "ok", `health.status is ${health.status}`)
        assert(health.providers === 0, `health.providers is ${health.providers}, expected 0`)
        assert(health.appId === APP_ID, `health.appId is ${health.appId}`)
        // Not `["fresh","stale","error"].includes(...)`: that accepted every
        // legal value and could never fail. An offline serve with a cold cache
        // directory must land on the bundled archive, which is `stale`.
        assert(health.pricing.status === "stale", `health.pricing.status is ${health.pricing.status}, expected "stale" (offline serve + cold cache → bundled archive)`)
        assert(health.pricing.source === "fallback", `health.pricing.source is ${health.pricing.source}, expected "fallback" (the bundled archive)`)
        numbers["AC1.health"] = { providers: health.providers, pricing: health.pricing.status, pricingSource: health.pricing.source, models: health.models }
      } finally {
        await stopChild(serve, "mik serve", proxyPort)
      }
      assert(serveOut.includes("Listening on"), `mik serve never printed its listening line:\n${serveOut}`)

      // The library path with no provider at all.
      const bare = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      try {
        assert(bare.providers.list().length === 0, "the fresh database already holds a provider")
        assert(bare.providers.defaultModel() === null, "the fresh database already holds a default model")
      } finally {
        bare.close()
      }

      numbers["AC1.port"] = proxyPort
      pass(`mik init wrote the config, the CLI server booted with 0 providers, port ${proxyPort} released on shutdown`)
    })

    // ───────────────────────── AC2 ─────────────────────────
    await step("AC2", "mock provider: add → test connection ok → models non-empty → set default", async () => {
      const add = await runCli([
        "provider",
        "add",
        "mock",
        "--protocol",
        "openai-compatible",
        "--base-url",
        mock.url,
        "--name",
        "Mock Provider",
        "--offline",
        "--cache-dir",
        cacheDir,
        "--config",
        configPath,
      ])
      assert(add.code === 0, `mik provider add exited ${add.code}\n${add.stdout}\n${add.stderr}`)
      assert(add.stdout.includes('Added provider "mock"'), "mik provider add did not confirm the provider")

      const list = await runCli(["provider", "list", "--offline",
        "--cache-dir",
        cacheDir, "--config", configPath])
      assert(list.code === 0, `mik provider list exited ${list.code}`)
      assert(list.stdout.includes("openai-compatible"), "the provider row is missing its protocol")
      assert(list.stdout.includes(mock.url), "the provider row is missing its base URL")

      // `mik provider test` / `mik models --refresh` refuse to run under
      // --offline (their own guard), so the same hub code paths are driven
      // directly here; the CLI surface is covered by add/list/models.
      const hub = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      try {
        const status = await hub.ai.test("mock")
        assert(status.ok === true, `provider test failed: ${status.message}`)
        assert(status.modelCount === MOCK_MODELS.length, `provider test reported ${status.modelCount} models, expected ${MOCK_MODELS.length}`)

        const discovered = await hub.models.refresh("mock")
        assert(discovered.length === MOCK_MODELS.length, `models.refresh returned ${discovered.length} models`)
        assert(discovered.every((model) => model.source === "provider_api"), "a discovered model is not tagged provider_api")
        assert(hub.models.list("mock").length > 0, "models.list is empty after a refresh")

        const cliModels = await runCli(["models", "--provider", "mock", "--offline",
        "--cache-dir",
        cacheDir, "--config", configPath])
        assert(cliModels.code === 0, `mik models exited ${cliModels.code}`)
        assert(cliModels.stdout.includes("mock:mock-mini"), "mik models does not show the discovered model")

        hub.providers.setDefaultModel("mock:mock-mini")
        assert(hub.providers.defaultModel() === "mock:mock-mini", `default model is ${hub.providers.defaultModel()}`)

        numbers["AC2"] = { models: discovered.length, latencyMs: status.latencyMs, defaultModel: hub.providers.defaultModel() }
        pass(`connection ok (${status.latencyMs} ms), ${discovered.length} models discovered, default = mock:mock-mini`)
      } finally {
        hub.close()
      }
    })

    // ── price P1: every request from here until AC7 is billed at 1/2 USD per M ──
    const priceP1 = { input: 1, output: 2 }
    const priceP2 = { input: 3, output: 15 }
    /** mock usage: input 1200 (800 of it cache-read), output 300. Cache-read defaults to the input rate. */
    const expectedCost = (price) => (400 * price.input + 800 * price.input + 300 * price.output) / 1_000_000

    await step("PRICE", `manual price P1 = $${priceP1.input}/M in, $${priceP1.output}/M out (mik pricing set)`, async () => {
      const set = await runCli([
        "pricing",
        "set",
        "mock-mini",
        "--input",
        String(priceP1.input),
        "--output",
        String(priceP1.output),
        "--offline",
        "--cache-dir",
        cacheDir,
        "--config",
        configPath,
      ])
      assert(set.code === 0, `mik pricing set exited ${set.code}\n${set.stdout}\n${set.stderr}`)
      const list = await runCli(["pricing", "list", "--offline",
        "--cache-dir",
        cacheDir, "--config", configPath])
      assert(list.stdout.includes("mock-mini"), "mik pricing list does not show the manual price")
      numbers["priceP1"] = { ...priceP1, expectedCostPerCall: expectedCost(priceP1) }
      pass(`P1 applied; a 1200/300 call costs $${expectedCost(priceP1)}`)
    })

    // ───────────────────────── EX1 ─────────────────────────
    await step("EX1", "examples/cli-agent: the embedded-library host, run as its own process", async () => {
      const run = await runNode(
        [CLI_AGENT_EXAMPLE, "--base-url", mock.url, "--provider", "mock", "--db", dbPath, "--app-id", APP_ID],
        { env: cleanEnv({ MIK_CACHE_DIR: cacheDir }) },
      )
      assert(run.code === 0, `the example exited ${run.code}\n${run.stdout}\n${run.stderr}`)
      assert(run.stdout.includes("ok        true"), `the connection test did not pass:\n${run.stdout}`)
      assert(run.stdout.includes("default mock:mock-mini"), `the example did not set the default:\n${run.stdout}`)
      assert(run.stdout.includes("get_weather"), `the tool call did not happen:\n${run.stdout}`)
      assert(run.stdout.includes("by source     generate=2 stream=1"), `unexpected per-source summary:\n${run.stdout}`)

      const reader = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, recordUsage: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      try {
        const rows = reader.usage.query({ limit: 100 }).events
        const example = rows.filter((row) => row.sessionId?.startsWith("cli-agent-"))
        assert(example.length === 3, `the example produced ${example.length} usage rows, expected 3`)
        assert(example.every((row) => closeTo(row.cost.usd, expectedCost(priceP1)) || closeTo(row.cost.usd, 2 * expectedCost(priceP1))), `unexpected costs ${JSON.stringify(example.map((row) => row.cost.usd))}`)
        numbers["EX1"] = { rows: example.length, costs: example.map((row) => row.cost.usd) }
        pass(`init → add → test → models → default → generate/stream/tool → usage summary, 3 metered rows`)
      } finally {
        reader.close()
      }
    })

    // ── the proxy endpoint shared by AC3, AC5 and AC7 ──
    let hub
    let server
    let base
    if (!injectFailure) {
      hub = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      cleanup.push(async () => hub.close())
      server = await createServer({ hub, port: proxyPort, host: "127.0.0.1", token: SERVER_TOKEN })
      cleanup.push(async () => server.close())
      base = hub.baseUrl
      assert(base === `http://127.0.0.1:${proxyPort}/v1`, `hub.baseUrl is ${base}`)
    }

    const chat = async (body) => {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SERVER_TOKEN}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      return { status: response.status, text: await response.text() }
    }

    // ───────────────────────── AC3 ─────────────────────────
    await step("AC3", "proxy endpoint: generate / stream / tool call, all three metered", async () => {
      const generated = await chat({ model: "mock:mock-mini", messages: [{ role: "user", content: "hello from the proxy" }], user: "e2e-proxy-generate" })
      assert(generated.status === 200, `generate returned HTTP ${generated.status}: ${generated.text.slice(0, 200)}`)
      const genBody = JSON.parse(generated.text)
      assert(genBody.choices?.[0]?.message?.content?.length > 0, "generate returned no content")
      assert(genBody.usage?.total_tokens === 1500, `generate usage.total_tokens is ${genBody.usage?.total_tokens}`)
      assert(genBody.x_modelhub?.provider === "mock", "the response carries no x_modelhub metering block")

      const streamed = await chat({ model: "mock:mock-mini", messages: [{ role: "user", content: "stream from the proxy" }], user: "e2e-proxy-stream", stream: true })
      assert(streamed.status === 200, `stream returned HTTP ${streamed.status}`)
      const frames = streamed.text.split("\n\n").filter((frame) => frame.startsWith("data:"))
      assert(frames.length >= 3, `the stream carried only ${frames.length} data frames`)
      assert(streamed.text.includes("data: [DONE]"), "the stream never sent the [DONE] sentinel")
      const streamedUsage = frames
        .map((frame) => frame.slice(5).trim())
        .filter((payload) => payload !== "[DONE]")
        .map((payload) => JSON.parse(payload))
        .map((chunk) => chunk.usage)
        .find(Boolean)
      assert(streamedUsage?.total_tokens === 1500, `the stream's final usage frame is ${JSON.stringify(streamedUsage)}`)

      const toolCall = await chat({
        model: "mock:mock-mini",
        messages: [{ role: "user", content: "what is the weather in Beijing? call the tool" }],
        user: "e2e-proxy-tool",
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Look up the current weather for a city.",
              parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            },
          },
        ],
      })
      assert(toolCall.status === 200, `tool call returned HTTP ${toolCall.status}`)
      const toolBody = JSON.parse(toolCall.text)
      const calls = toolBody.choices?.[0]?.message?.tool_calls
      assert(Array.isArray(calls) && calls.length > 0, `no tool_calls in the response: ${toolCall.text.slice(0, 200)}`)
      assert(calls[0].function?.name === "get_weather", `unexpected tool name ${calls[0].function?.name}`)

      const reader = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, recordUsage: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      try {
        const rows = ["e2e-proxy-generate", "e2e-proxy-stream", "e2e-proxy-tool"].map((sessionId) => {
          const page = reader.usage.query({ sessionId, limit: 10 })
          assert(page.total === 1, `session ${sessionId} has ${page.total} usage rows, expected 1`)
          return page.events[0]
        })
        const sources = rows.map((row) => row.source).join(",")
        assert(sources === "generate,stream,generate", `unexpected sources: ${sources}`)
        for (const row of rows) {
          assert(row.status === "ok", `row ${row.requestId} has status ${row.status}`)
          assert(row.usage.input >= 1200 && row.usage.output >= 300, `row ${row.requestId} has usage ${JSON.stringify(row.usage)}`)
          assert(row.cost.source === "manual", `row ${row.requestId} was priced from ${row.cost.source}`)
          assert(row.cost.usd > 0, `row ${row.requestId} cost $0`)
        }
        numbers["AC3"] = { rows: rows.length, sources, costs: rows.map((row) => row.cost.usd), requestIds: rows.map((row) => row.requestId) }
        pass(`3 requests → 3 usage rows (${sources}), costs ${JSON.stringify(rows.map((row) => row.cost.usd))}`)
      } finally {
        reader.close()
      }
    })

    // ───────────────────────── AC4 ─────────────────────────
    await step("AC4", "examples/openai-sdk: unchanged SDK code, metered as source=fetch", async () => {
      const run = await runNode([OPENAI_SDK_EXAMPLE, "--db", dbPath, "--app-id", APP_ID, "--model", "mock:mock-mini"], {
        env: cleanEnv({ MIK_EXAMPLE_PROVIDER: "mock", MIK_CACHE_DIR: cacheDir }),
      })
      assert(run.code === 0, `the example exited ${run.code}\n${run.stdout}\n${run.stderr}`)
      assert(run.stdout.includes("metered rows (source=fetch): 1"), `unexpected metering line:\n${run.stdout}`)

      const reader = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, recordUsage: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      try {
        const fetched = reader.usage.query({ limit: 100 }).events.filter((event) => event.source === "fetch")
        assert(fetched.length >= 1, "no usage row with source=fetch was recorded")
        const row = fetched[0]
        assert(row.modelActual === "mock-mini", `the metered model is ${row.modelActual}`)
        assert(row.cost.source === "manual" && closeTo(row.cost.usd, expectedCost(priceP1)), `the SDK call cost is ${JSON.stringify(row.cost)}`)
        numbers["AC4"] = { rows: fetched.length, cost: row.cost.usd, tokens: row.usage }
        pass(`the SDK call was metered (source=fetch, cost $${row.cost.usd})`)
      } finally {
        reader.close()
      }
    })

    // ───────────────────────── AC5 ─────────────────────────
    await step("AC5", "examples/python-host: cross-language call metered", async () => {
      const version = spawnSync(PYTHON, ["--version"], { encoding: "utf8" })
      assert(version.status === 0, `python not usable (${PYTHON}); set MIK_E2E_PYTHON to a python 3 binary`)
      const run = await spawnCapture(PYTHON, [PYTHON_EXAMPLE, base, "mock:mock-mini"], {
        env: cleanEnv({ MIK_CACHE_DIR: cacheDir, MIK_SERVER_TOKEN: SERVER_TOKEN }),
      })
      assert(run.code === 0, `the Python host exited ${run.code}\n${run.stdout}\n${run.stderr}`)
      assert(run.stdout.includes("usage:"), `the Python host printed no usage:\n${run.stdout}`)

      const reader = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, recordUsage: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      try {
        const page = reader.usage.query({ sessionId: "python-host", limit: 10 })
        assert(page.total === 1, `session python-host has ${page.total} usage rows, expected 1`)
        const row = page.events[0]
        assert(row.status === "ok", `the Python call was recorded as ${row.status}`)
        assert(row.usage.input === 1200 && row.usage.output === 300, `the Python call recorded usage ${JSON.stringify(row.usage)}`)
        numbers["AC5"] = { rows: page.total, cost: row.cost.usd, tokens: row.usage }
        pass(`the Python call was metered (cost $${row.cost.usd}, ${row.usage.input}/${row.usage.output} tokens)`)
      } finally {
        reader.close()
      }
    })

    // ───────────────────────── AC6 ─────────────────────────
    await step("AC6", "price catalogue unreachable → pricing degrades to stale and still quotes", async () => {
      const unreachableCatalog = new PricingCatalog({
        sources: [{ name: "unreachable", url: "http://127.0.0.1:1/prices.json", parse: () => new Map() }],
        fetch: unreachableFetch,
        onWarn: () => {},
      })
      const isolated = await ModelInfra.init({ appId: APP_ID, db: ":memory:", syncCatalog: false, pricingCatalog: unreachableCatalog, onWarn: () => {} })
      try {
        const state = isolated.pricing.state()
        assert(state.status === "stale", `pricing state is ${state.status}, expected stale`)
        assert(state.source === "fallback", `pricing source is ${state.source}, expected fallback`)
        const quote = isolated.pricing.estimate({ model: "deepseek-chat", usage: { input: 1_000_000, output: 1_000_000 } })
        assert(quote.source !== "missing", `the archive did not quote deepseek-chat: ${JSON.stringify(quote)}`)
        assert(quote.usd > 0, `the quote is $${quote.usd}`)
        numbers["AC6"] = { status: state.status, source: state.source, quoteUsd: quote.usd, basis: quote.basis }

        const cli = await runCli(["pricing", "list", "--offline",
        "--cache-dir",
        cacheDir, "--config", configPath])
        assert(cli.code === 0, `mik pricing list exited ${cli.code}`)
        assert(/status\s+stale/.test(cli.stdout), `mik pricing list does not report a stale catalogue:\n${cli.stdout}`)
        pass(`status=${state.status}, source=${state.source}, deepseek-chat still quotes $${quote.usd}/M tokens`)
      } finally {
        isolated.close()
      }
    })

    // ───────────────────────── AC7 ─────────────────────────
    await step("AC7", "manual price change: history frozen, new requests re-priced", async () => {
      const reader = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, recordUsage: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      let historyId
      let historyCost
      try {
        const history = reader.usage.query({ sessionId: "e2e-proxy-generate", limit: 1 }).events[0]
        assert(history, "the AC3 generate row is missing")
        historyId = history.requestId
        historyCost = history.cost.usd
        assert(closeTo(historyCost, expectedCost(priceP1)), `the history row was priced at $${historyCost}, expected $${expectedCost(priceP1)}`)
      } finally {
        reader.close()
      }

      const set = await runCli([
        "pricing",
        "set",
        "mock-mini",
        "--input",
        String(priceP2.input),
        "--output",
        String(priceP2.output),
        "--offline",
        "--cache-dir",
        cacheDir,
        "--config",
        configPath,
      ])
      assert(set.code === 0, `mik pricing set exited ${set.code}\n${set.stdout}\n${set.stderr}`)

      const reader2 = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, recordUsage: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      try {
        const again = reader2.usage.get(historyId, { appId: APP_ID })
        assert(again, `usage.get(${historyId}) returned nothing`)
        assert(closeTo(again.cost.usd, historyCost), `the history row changed from $${historyCost} to $${again.cost.usd}`)
        assert(closeTo(again.cost.usd, expectedCost(priceP1)), "the history row was re-priced instead of staying frozen")
      } finally {
        reader2.close()
      }

      const fresh = await hub.generate({
        messages: [{ role: "user", content: "priced after the manual price change" }],
        sessionId: "e2e-after-reprice",
      })
      assert(closeTo(fresh.cost.usd, expectedCost(priceP2)), `the new request cost $${fresh.cost.usd}, expected $${expectedCost(priceP2)}`)
      assert(!closeTo(fresh.cost.usd, expectedCost(priceP1)), "the new request still used the old price")

      const reader3 = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, recordUsage: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      try {
        const stored = reader3.usage.query({ sessionId: "e2e-after-reprice", limit: 1 }).events[0]
        assert(stored, "the re-priced request was not stored")
        assert(closeTo(stored.cost.usd, expectedCost(priceP2)), `the stored row is $${stored.cost.usd}`)
        assert(stored.cost.source === "manual", `the stored row's price source is ${stored.cost.source}`)
      } finally {
        reader3.close()
      }

      numbers["AC7"] = { historyCost, newCost: fresh.cost.usd, priceP1: expectedCost(priceP1), priceP2: expectedCost(priceP2) }
      pass(`history $${historyCost} unchanged, new request $${fresh.cost.usd} (P2 = $${expectedCost(priceP2)})`)
    })

    // ───────────────────────── DASH ─────────────────────────
    await step("DASH", "SPEC §6 ③: the dashboard shows the recorded rows, the cost breakdown and the price source", async () => {
      const { port: dashPort, note: dashNote } = await pickPort(DASHBOARD_PORT)
      const buildNote = await ensureDashboardBuild()

      // The expected strings come from the same helpers the pages use, applied
      // to the numbers this run actually wrote — not from literals.
      const summary = hub.usage.summary()
      assert(summary.requests >= 9, `the hub recorded only ${summary.requests} rows, the dashboard check needs the usage written above`)
      assert(summary.costUsd > 0, "the hub recorded no cost at all")
      const ac3RequestId = hub.usage.query({ sessionId: "e2e-proxy-generate", limit: 1 }).events[0]?.requestId
      assert(ac3RequestId, "the AC3 generate row is missing, so there is nothing for the log page to show")
      const expected = {
        cost: formatUsd(summary.costUsd),
        requests: formatInt(summary.requests),
        tokens: formatCompact(tokenTotal(summary.tokens)),
        rowCost: formatUsd(expectedCost(priceP1)),
        inputRate: formatRate(priceP2.input),
        outputRate: formatRate(priceP2.output),
      }

      const withDashboard = async (serverUrl, body) => {
        const started = startDashboard(dashPort, serverUrl)
        try {
          await waitForPage(`http://127.0.0.1:${dashPort}`, "/")
          return await body()
        } finally {
          await stopChild(started.child, "dashboard", dashPort)
        }
      }

      const live = breakDashboard ? DEAD_SERVER_URL : `http://127.0.0.1:${proxyPort}`

      await withDashboard(live, async () => {
        const home = plainText((await getHtml(`http://127.0.0.1:${dashPort}/`)).body)
        assert(home.includes(expected.cost), `the overview does not show the total cost ${expected.cost}`)
        assert(new RegExp(`tabular-nums[^>]*>${expected.requests}<`).test(home), `the overview does not show the request count ${expected.requests}`)
        assert(home.includes(expected.tokens), `the overview does not show the token total ${expected.tokens}`)
        assert(home.includes(APP_ID), `the overview does not name the app ${APP_ID}`)
        assert(home.includes("pricing stale"), "the overview does not show the price source badge (pricing stale)")
        assert(home.includes("mock"), "the overview does not list the mock provider bucket")

        const logs = plainText((await getHtml(`http://127.0.0.1:${dashPort}/logs`)).body)
        assert(logs.includes(ac3RequestId), `the log page does not show the recorded request ${ac3RequestId}`)
        assert(logs.includes(expected.rowCost), `the log page does not show the per-request cost ${expected.rowCost}`)
        assert(logs.includes("mock-mini"), "the log page does not show the model")
        assert(new RegExp(`>${expected.requests}</span> 条`).test(logs), `the log page does not report ${summary.requests} rows`)

        const pricing = plainText((await getHtml(`http://127.0.0.1:${dashPort}/pricing`)).body)
        assert(pricing.includes("mock-mini"), "the pricing page does not list the manual price")
        assert(pricing.includes(expected.inputRate), `the pricing page does not show the manual input rate ${expected.inputRate}`)
        assert(pricing.includes(expected.outputRate), `the pricing page does not show the manual output rate ${expected.outputRate}`)
        assert(pricing.includes("手动价（1）"), "the pricing page does not report exactly one manual override")

        const proxied = await getJson(`http://127.0.0.1:${dashPort}/api/mik/health`)
        assert(proxied.status === 200 && proxied.body.status === "ok", `the dashboard's /api/mik proxy answered ${JSON.stringify(proxied)}`)
        assert(proxied.body.appId === APP_ID, `the proxied health reports appId ${proxied.body.appId}`)

        // What the log drawer shows: the price source behind the row.
        const detail = await getJson(`http://127.0.0.1:${dashPort}/api/mik/usage/logs/${ac3RequestId}`)
        assert(detail.status === 200, `the proxied log detail answered HTTP ${detail.status}`)
        assert(detail.body.event?.cost?.source === "manual", `the row's price source is ${detail.body.event?.cost?.source}, expected manual`)
      })

      // Same pages, unreachable upstream: the numbers must disappear and the
      // banner must explain why. That is what proves the HTML above is live
      // data fetched over HTTP rather than markup the page can render alone.
      await withDashboard(DEAD_SERVER_URL, async () => {
        const offline = plainText((await getHtml(`http://127.0.0.1:${dashPort}/`)).body)
        assert(!offline.includes(expected.cost), "the overview still shows the cost with an unreachable mik serve — the number is not live data")
        assert(/无法连接 mik serve|请求 mik serve 失败/.test(offline), "the overview does not explain that mik serve is unreachable")
        // EVO-G09 A1 first-screen order: the neutral guide is the first block, and
        // the error-styled banner is only a reaction to pressing 重试 — so it must
        // not be painted at all on first paint. Anchored on `data-testid` rather
        // than on copy, and asserting the banner's *absence* rather than a text
        // position (the latter was trivially true while the banner is behind
        // `retried && !pending`, i.e. never in the server-rendered HTML).
        assert(offline.includes('data-testid="upstream-guide"'), "the offline overview does not open with the neutral upstream guide")
        assert(offline.includes("先启动上游"), "the offline overview's guide lost its 先启动上游 copy")
        assert(
          !offline.includes('data-testid="upstream-error"'),
          "the offline overview paints the error banner on first paint instead of waiting for 重试",
        )
      })

      numbers["DASH"] = {
        port: dashPort,
        build: buildNote,
        costUsd: expected.cost,
        requests: summary.requests,
        tokens: expected.tokens,
        rowCost: expected.rowCost,
        manualRates: [expected.inputRate, expected.outputRate],
        requestId: ac3RequestId,
        degraded: breakDashboard ? "forced (--break-dashboard)" : "verified with an unreachable upstream",
      }
      pass(
        `port ${dashPort} (${dashNote}); ${buildNote}; / shows ${expected.cost} / ${expected.requests} requests / ${expected.tokens} tokens, ` +
          `/logs shows ${ac3RequestId} at ${expected.rowCost}, /pricing shows ${expected.inputRate}/${expected.outputRate}; unreachable upstream degrades to a banner`,
      )
    })

    // ───────────────────────── DIST ─────────────────────────
    await step("DIST", "the published artifact (packages/mik/dist) runs: CLI --help, serve, /api/health", async () => {
      if (!existsSync(DIST_CLI)) {
        const build = await runPnpm(["--filter", "model-infra-kit", "build"])
        assert(build.code === 0, `pnpm --filter model-infra-kit build exited ${build.code}\n${build.stdout.slice(-2000)}\n${build.stderr.slice(-2000)}`)
      }
      assert(existsSync(DIST_CLI), `${DIST_CLI} is missing after the build`)

      const help = await spawnCapture(process.execPath, [DIST_CLI, "--help"])
      assert(help.code === 0, `dist/cli.mjs --help exited ${help.code}\n${help.stdout}\n${help.stderr}`)
      assert(help.stdout.includes("COMMANDS") && help.stdout.includes("serve"), `dist/cli.mjs --help printed no command list:\n${help.stdout}`)

      const { port: distPort, note: distNote } = await pickPort(DIST_PORT)
      const child = spawn(
        process.execPath,
        [DIST_CLI, "serve", "--offline", "--cache-dir", cacheDir, "--config", configPath, "--port", String(distPort)],
        { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(), cwd: ROOT },
      )
      let output = ""
      child.stdout.on("data", (chunk) => (output += chunk))
      child.stderr.on("data", (chunk) => (output += chunk))
      try {
        const health = await waitForHealth(`http://127.0.0.1:${distPort}`)
        assert(health.status === "ok", `dist serve health.status is ${health.status}`)
        assert(health.appId === APP_ID, `dist serve health.appId is ${health.appId}`)
        assert(health.providers === 1, `dist serve reports ${health.providers} providers, expected the mock provider added in AC2`)
        assert(health.models === MOCK_MODELS.length, `dist serve reports ${health.models} models, expected ${MOCK_MODELS.length}`)
        assert(health.pricing.status === "stale" && health.pricing.source === "fallback", `dist serve pricing is ${JSON.stringify(health.pricing)}`)
        assert(output.includes("Listening on"), `dist serve never printed its listening line:\n${output}`)
        numbers["DIST"] = { cli: DIST_CLI, port: distPort, providers: health.providers, models: health.models, pricing: health.pricing.status }
        pass(`dist/cli.mjs --help ok; dist serve on ${distPort} (${distNote}) answered /api/health with ${health.providers} provider / ${health.models} models`)
      } finally {
        await stopChild(child, "dist serve", distPort)
      }
    })

    // ───────────────────────── AC8 ─────────────────────────
    await step("AC8", "a failing check makes the runner exit non-zero and name the failure", async () => {
      const run = await runNode([fileURLToPath(import.meta.url), "--inject-failure"])
      assert(run.code !== 0, `the injected-failure run exited ${run.code}, expected non-zero`)
      assert(run.stdout.includes("FAIL  AC1"), "the failing run printed no FAIL line for AC1")
      assert(run.stdout.includes("check(s) failed"), "the failing run printed no failure summary")
      numbers["AC8"] = { injectedExitCode: run.code }
      pass(`injected failure → exit code ${run.code} with a FAIL line and a failure summary`)
    })
  } finally {
    // ───────────────────────── summary ─────────────────────────
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose()
      } catch (error) {
        process.stdout.write(`  cleanup warning: ${messageOf(error)}\n`)
      }
    }

    const failed = checks.filter((check) => !check.ok)

    process.stdout.write("\n================ acceptance summary ================\n")
    for (const check of checks) {
      process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.id.padEnd(6)} ${check.title}\n`)
      if (check.detail) process.stdout.write(`        ${check.detail}\n`)
    }

    let totals = null
    try {
      const reader = await ModelInfra.init({ appId: APP_ID, db: dbPath, syncCatalog: false, recordUsage: false, pricingFetch: unreachableFetch, cacheDir, onWarn: () => {} })
      totals = reader.usage.summary()
      const bySource = new Map()
      for (const event of reader.usage.query({ limit: 1000 }).events) {
        bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1)
      }
      numbers["rowsBySource"] = Object.fromEntries(bySource)
      reader.close()
    } catch (error) {
      process.stdout.write(`\n(no usage summary: ${messageOf(error)})\n`)
    }

    process.stdout.write("\n------------------------ key numbers ------------------------\n")
    process.stdout.write(`  mock provider calls     ${mock.calls.length}\n`)
    process.stdout.write(`  proxy port              ${proxyPort}\n`)
    process.stdout.write(`  dashboard port          ${numbers["DASH"]?.port ?? "—"} (stopped, port released)\n`)
    process.stdout.write(`  dist serve port         ${numbers["DIST"]?.port ?? "—"} (stopped, port released)\n`)
    if (totals) {
      process.stdout.write(`  usage rows              ${totals.requests} (ok ${totals.successes}, failed ${totals.failures})\n`)
      process.stdout.write(`  rows by source          ${JSON.stringify(numbers["rowsBySource"])}\n`)
      process.stdout.write(`  tokens                  ${JSON.stringify(totals.tokens)}\n`)
      process.stdout.write(`  cost (USD)              ${totals.costUsd}\n`)
      process.stdout.write(`  cache hit rate          ${(totals.cacheHitRate * 100).toFixed(2)}%\n`)
    }
    for (const [key, value] of Object.entries(numbers)) {
      if (key === "rowsBySource") continue
      process.stdout.write(`  ${key.padEnd(23)} ${JSON.stringify(value)}\n`)
    }
    let dbBytes = 0
    try {
      dbBytes = statSync(dbPath).size
    } catch {}
    process.stdout.write(`  sqlite database         ${dbPath} (${dbBytes} bytes)\n`)
    process.stdout.write(`  elapsed                 ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`)

    if (failed.length > 0) {
      process.stdout.write(`\n${failed.length} check(s) failed: ${failed.map((check) => check.id).join(", ")}\n`)
      exitCode = 1
    } else {
      process.stdout.write("\nAll checks passed.\n")
      exitCode = 0
    }
    process.stdout.write(`exit code ${exitCode}\n`)
  }

  process.exitCode = exitCode
}

// ── the runner re-executes itself so `node scripts/e2e/run.mjs` needs no flags ──
const alreadyFlagged = process.execArgv.some((arg) => arg === TRANSFORM_FLAG || arg.startsWith(`${TRANSFORM_FLAG}=`))
if (!alreadyFlagged && process.env.MIK_E2E_REEXEC !== "1") {
  const child = spawn(
    process.execPath,
    [TRANSFORM_FLAG, "--disable-warning=ExperimentalWarning", "--import", LOADER_URL, fileURLToPath(import.meta.url), ...argv],
    { stdio: "inherit", env: { ...process.env, MIK_E2E_REEXEC: "1" } },
  )
  child.on("exit", (code) => process.exit(code ?? 1))
} else {
  await main()
}
