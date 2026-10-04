#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stripTypeScriptTypes } from "node:module"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "../..")
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "mik")
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, "package.json")
const CONTRACT_MARKER = "<!-- release-battery-runtime-exports:v1 -->"
const EXPECTED_ENTRYPOINTS = [".", "./auto", "./cli", "./server"]

function commandName(command) {
  return process.platform === "win32" && (command === "pnpm" || command === "npm") ? `${command}.cmd` : command
}

function executableFor(command, args) {
  if (process.platform !== "win32") return { file: command, args }
  if (command === "node") return { file: process.execPath, args }
  const nodeDir = dirname(process.execPath)
  if (command === "pnpm") return { file: process.execPath, args: [join(nodeDir, "node_modules", "pnpm", "bin", "pnpm.mjs"), ...args] }
  if (command === "npm") return { file: process.execPath, args: [join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), ...args] }
  return { file: commandName(command), args }
}

function assertAbsoluteCwd(cwd, label) {
  assert.ok(typeof cwd === "string" && resolve(cwd) === cwd, `${label} cwd must be an absolute path`)
  assert.ok(existsSync(cwd), `${label} cwd does not exist: ${cwd}`)
}

// Load the same source redactor before build/installation errors can be printed.
const redactorSource = readFileSync(join(PACKAGE_ROOT, "src", "util", "redact.ts"), "utf8")
const sourceRedactor = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(redactorSource)).toString("base64"))
let projectRedact = sourceRedactor.redact

function redacted(text, secrets = []) {
  return secrets.reduce((value, secret) => (secret ? value.replaceAll(secret, "[redacted]") : value), projectRedact(text))
}

function run(command, args, { cwd, label = command, env = process.env, redactSecrets = [], printOutput = true } = {}) {
  assertAbsoluteCwd(cwd, label)
  process.stdout.write(`[run] ${label} cwd=${cwd}\n`)
  const executable = executableFor(command, args)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable.file, executable.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)))
    child.on("close", (code, signal) => {
      const safeStdout = redacted(stdout, redactSecrets)
      const safeStderr = redacted(stderr, redactSecrets)
      if (code !== 0) {
        if (!printOutput) {
          reject(new Error(label + " failed (exit " + code + "); output withheld until project redactor is available."))
          return
        }
        const details = [safeStdout.trim(), safeStderr.trim()].filter(Boolean).join("\n")
        reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}\n${details}`))
        return
      }
      if (printOutput && safeStdout.trim()) process.stdout.write(safeStdout)
      if (printOutput && safeStderr.trim()) process.stderr.write(safeStderr)
      resolvePromise({ stdout, stderr })
    })
  })
}

function writeAbsolute(path, contents) {
  assert.ok(resolve(path) === path, `write target must be absolute: ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, "utf8")
  process.stdout.write(`[write] ${path}\n`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function normalizeRelative(path) {
  return path.split(sep).join("/")
}

function walkFiles(root, current = root) {
  const files = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(root, path))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`unexpected non-file package entry: ${path}`)
  }
  return files
}

function assertInside(base, target, label) {
  const suffix = relative(resolve(base), resolve(target))
  assert.ok(suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !suffix.startsWith("/")), `${label} escaped clean room: ${target}`)
}

function contractFromDocs() {
  const docsPath = join(REPO_ROOT, "docs", "interfaces.md")
  const markdown = readFileSync(docsPath, "utf8")
  const markerAt = markdown.indexOf(CONTRACT_MARKER)
  assert.ok(markerAt >= 0, `runtime export contract marker missing from ${docsPath}`)
  const fenceAt = markdown.indexOf("```json", markerAt)
  assert.ok(fenceAt >= 0, `runtime export contract JSON block missing from ${docsPath}`)
  const bodyStart = fenceAt + "```json".length
  const bodyEnd = markdown.indexOf("```", bodyStart)
  assert.ok(bodyEnd >= 0, `runtime export contract JSON block is not closed in ${docsPath}`)
  const contract = JSON.parse(markdown.slice(bodyStart, bodyEnd).trim())
  assert.equal(contract.format, "mik-runtime-exports/v1", "runtime export contract format mismatch")
  assert.ok(contract.entrypoints && typeof contract.entrypoints === "object" && !Array.isArray(contract.entrypoints), "runtime export contract entrypoints must be an object")
  assert.deepEqual(Object.keys(contract.entrypoints).sort(), [...EXPECTED_ENTRYPOINTS].sort(), "runtime export contract entrypoint set mismatch")
  for (const [entrypoint, symbols] of Object.entries(contract.entrypoints)) {
    assert.ok(Array.isArray(symbols), `${entrypoint} runtime export contract must be an array`)
    assert.deepEqual(symbols, [...new Set(symbols)].sort(), `${entrypoint} runtime export contract must be sorted and unique`)
    assert.ok(symbols.every((symbol) => typeof symbol === "string" && symbol.length > 0), `${entrypoint} runtime export contract contains an invalid symbol`)
  }
  return contract.entrypoints
}

function compareExports(entrypoint, expected, actual) {
  const missing = expected.filter((symbol) => !actual.includes(symbol))
  const unexpected = actual.filter((symbol) => !expected.includes(symbol))
  if (missing.length || unexpected.length) {
    throw new Error(`${entrypoint} runtime exports differ; missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`)
  }
  process.stdout.write(`[exports] ${entrypoint}: ${actual.length} runtime symbols exact\n`)
}

function contractFailureSelfCheck() {
  const expected = contractFromDocs()
  const deliberateExtra = "__release_battery_deliberate_contract_mismatch__"
  const actual = [...expected["."], deliberateExtra].sort()
  let detected = false
  try {
    compareExports(".", expected["."], actual)
  } catch (error) {
    detected = error instanceof Error && error.message.includes("runtime exports differ")
  }
  assert.equal(detected, true, "contract failure self-check did not detect the deliberate mismatch")
  assert.throws(() => compareExports("./auto", expected["./auto"], []), /runtime exports differ/, "missing auto exports must fail")
  process.stderr.write("[self-test] deliberate runtime export mismatch detected; exit code 1 is expected\n")
}

function autoArtifactFailureSelfCheck() {
  const room = mkdtempSync(join(tmpdir(), "mik-release-missing-auto-"))
  const manifest = { files: ["dist", "LICENSE"], exports: { "./auto": { import: "./dist/auto.mjs", types: "./dist/auto.d.mts" } } }
  writeAbsolute(join(room, "package.json"), JSON.stringify(manifest))
  assert.throws(() => checkPackageFiles(room, manifest), /auto.*target missing/, "missing auto artifact must fail")
  process.stderr.write(`[self-test] deliberate missing auto artifact detected; retained=${room}; exit code 1 is expected\n`)
}

function installedRuntimeSource() {
  return String.raw`import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { resolve, sep } from "node:path"

const root = resolve(process.cwd())
const packageJson = fileURLToPath(await import.meta.resolve("model-infra-kit/package.json"))
assert.ok(packageJson.startsWith(root + sep), "installed package resolved outside the clean consumer directory")
// Import auto in a deliberate no-service environment; export inspection must not adopt a running host gateway.
process.env.MIK_GATEWAY_URL = "http://127.0.0.1:1"
const entries = [[".", "model-infra-kit"], ["./server", "model-infra-kit/server"], ["./cli", "model-infra-kit/cli"], ["./auto", "model-infra-kit/auto"]]
const output = {}
for (const [entrypoint, specifier] of entries) output[entrypoint] = Object.keys(await import(specifier)).sort()
console.log(JSON.stringify(output))
`
}

async function loadProjectRedactor() {
  const builtEntry = join(PACKAGE_ROOT, "dist", "index.mjs")
  assert.ok(existsSync(builtEntry), `built entry missing for redactor: ${builtEntry}`)
  const namespace = await import(`${pathToFileURL(builtEntry).href}?release-battery-redactor=${Date.now()}`)
  assert.equal(typeof namespace.redact, "function", "packed build does not expose the project redact() helper")
  projectRedact = namespace.redact
}

function collectExportTargets(value, path = "exports", output = []) {
  if (typeof value === "string") {
    output.push({ path, target: value })
    return output
  }
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${path} must contain strings or condition objects`)
  for (const [key, child] of Object.entries(value)) collectExportTargets(child, `${path}.${key}`, output)
  return output
}

function isWhitelisted(relativePath, patterns) {
  if (relativePath === "package.json" || relativePath === "README.md" || relativePath === "LICENSE") return true
  return patterns.some((pattern) => {
    if (typeof pattern !== "string" || pattern.length === 0) return false
    const normalized = pattern.replaceAll("\\", "/").replace(/\/$/, "")
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`)
  })
}

function checkPackageFiles(packagePath, packageJson) {
  assert.ok(Array.isArray(packageJson.files), "packed package.json files must be an array")
  assert.ok(packageJson.files.includes("dist"), "package.json files must include dist")
  assert.ok(packageJson.files.includes("LICENSE"), "package.json files must include LICENSE")
  const actualFiles = walkFiles(packagePath).map((path) => normalizeRelative(relative(packagePath, path))).sort()
  const unexpected = actualFiles.filter((path) => !isWhitelisted(path, packageJson.files))
  assert.deepEqual(unexpected, [], `packed files outside package.json whitelist: ${JSON.stringify(unexpected)}`)
  assert.ok(actualFiles.includes("package.json"), "packed package.json missing")
  process.stdout.write(`[files] ${actualFiles.length} packed files all satisfy package.json files whitelist\n`)

  const targets = collectExportTargets(packageJson.exports)
  for (const { path, target } of targets) {
    assert.ok(target.startsWith("./") && !target.includes(".."), `${path} has unsafe export target ${target}`)
    const targetPath = join(packagePath, target.slice(2))
    assert.ok(existsSync(targetPath) && statSync(targetPath).isFile(), `${path} target missing from packed package: ${target}`)
  }
  process.stdout.write(`[exports] ${targets.length} package export targets present\n`)
  return actualFiles
}

function smokeSource() {
  return String.raw`import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { ModelInfra, Store, redact } from "model-infra-kit"
import { createServer as createGateway } from "model-infra-kit/server"
import { spawnSync } from "node:child_process"

const consumerRoot = resolve(process.cwd())
const packageJsonPath = fileURLToPath(await import.meta.resolve("model-infra-kit/package.json"))
assert.ok(packageJsonPath.startsWith(consumerRoot + sep), "model-infra-kit resolved outside the clean consumer directory")
const installedPackage = JSON.parse(readFileSync(packageJsonPath, "utf8"))
assert.equal(installedPackage.version, process.env.MIK_BATTERY_EXPECTED_VERSION)
const cliEntry = fileURLToPath(import.meta.resolve("model-infra-kit/cli"))
const version = spawnSync(process.execPath, [cliEntry, "--version"], { encoding: "utf8", env: { ...process.env, MIK_LANG: undefined, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }, windowsHide: true })
assert.equal(version.status, 0)
assert.equal(version.stdout.trim(), "mik " + installedPackage.version)
const providerKey = process.env.MIK_RELEASE_BATTERY_KEY
assert.ok(providerKey, "the private mock provider key was not injected")

const mock = createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "not found" } }))
    return
  }
  if (request.headers.authorization !== "Bearer " + providerKey) {
    response.writeHead(401, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "unauthorized" } }))
    return
  }
  let requestBody = ""
  for await (const chunk of request) requestBody += chunk
  const parsed = JSON.parse(requestBody)
  assert.equal(parsed.model, "mock-model")
  await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({
    id: "release-battery",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "mock-model",
    choices: [{ index: 0, message: { role: "assistant", content: "battery ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }))
})

await new Promise((resolvePromise, reject) => {
  mock.once("error", reject)
  mock.listen(0, "127.0.0.1", resolvePromise)
})
const address = mock.address()
assert.ok(address && typeof address === "object" && address.port > 0, "mock provider did not bind an ephemeral port")
const dbPath = join(consumerRoot, "usage.db")
let hub
let store
let gateway
try {
  hub = await ModelInfra.init({
    appId: "release-battery",
    db: dbPath,
    cacheDir: join(consumerRoot, "cache"),
    syncCatalog: false,
    pricingAutoSync: false,
    maxRetries: 0,
    providers: [{
      id: "mock",
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1:" + address.port + "/v1",
      apiKeyRef: "env:MIK_RELEASE_BATTERY_KEY",
      enabled: true,
    }],
    defaultModel: "mock:mock-model",
    router: { aliases: { auto: { rules: [{ condition: "context_tokens > 8", target: "mock:mock-model" }], default_target: "mock:mock-model" } } },
  })
  assert.equal(hub.providers.get("mock")?.apiKeyRef, "env:MIK_RELEASE_BATTERY_KEY")
  hub.pricing.setOverride({ modelId: "mock-model", inputPerM: 1, outputPerM: 2 })
  const result = await hub.generate({ model: "mock:mock-model", messages: [{ role: "user", content: "hello" }] })
  assert.equal(result.text, "battery ok")
  assert.deepEqual(result.usage, { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  assert.equal(Math.round(result.cost.usd * 1_000_000), 11)
  assert.equal(Math.round(result.cost.low * 1_000_000), 11)
  assert.equal(Math.round(result.cost.high * 1_000_000), 11)
  const summary = hub.usage.summary()
  assert.equal(summary.requests, 1)
  assert.equal(Math.round(summary.costLowUsd * 1_000_000), 11)
  const event = hub.usage.query().events[0]
  assert.ok(event)
  assert.equal(Math.round(event.cost.usd * 1_000_000), 11)
  assert.ok(!JSON.stringify(event).includes(providerKey), "provider key leaked into usage data")
  await hub.generate({ model: "auto", traceId: "battery-routing", messages: [{ role: "user", content: "中".repeat(32) }] })
  const routed = hub.usage.query().events.find(row => row.traceId === "battery-routing")
  assert.equal(routed.modelRequested, "auto")
  assert.equal(routed.providerId, "mock")
  assert.equal(routed.modelActual, "mock-model")
  assert.equal(routed.tags.routing_rule, "context_tokens > 8")
  assert.equal(routed.tags.virtual_model, "auto")
  assert.equal(Math.round(routed.cost.usd * 1_000_000), 11)
  const gatewayToken = providerKey + "-gateway"
  gateway = await createGateway({ hub, port: 0, heartbeatMs: 20, tokens: [
    { token: gatewayToken, scopes: ["write:chat", "read:usage"], appId: "battery-tenant" },
    { token: gatewayToken + "-host", scopes: ["admin"], appId: "release-battery" },
    { token: gatewayToken + "-write", scopes: ["write:chat"], appId: "battery-tenant" },
  ] })
  const headers = { authorization: "Bearer " + gatewayToken, "content-type": "application/json" }
  const snapshot = async (token = gatewayToken) => {
    const response = await fetch(gateway.url + "/api/connections", { headers: { authorization: "Bearer " + token } })
    assert.equal(response.status, 200)
    return response.json()
  }
  const until = async predicate => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const value = await snapshot()
      if (predicate(value)) return value
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
    }
    throw new Error("connection lifecycle did not reach expected state")
  }
  assert.equal((await fetch(gateway.url + "/api/connections")).status, 401)
  assert.equal((await fetch(gateway.url + "/api/connections", { headers: { authorization: "Bearer " + gatewayToken + "-write" } })).status, 403)
  const pendingChat = fetch(gateway.url + "/v1/chat/completions", { method: "POST", headers,
    body: JSON.stringify({ model: "mock:mock-model", messages: [{ role: "user", content: "tenant hello" }] }) })
  const activeChat = await until(value => value.requests === 1 && value.connections[0].model === "mock:mock-model")
  assert.equal(activeChat.active, 1)
  assert.equal(activeChat.connections[0].appId, "battery-tenant")
  assert.equal((await snapshot(gatewayToken + "-host")).active, 0)
  const chat = await pendingChat
  assert.equal(chat.status, 200)
  assert.equal((await chat.json()).choices[0].message.content, "battery ok")
  await until(value => value.active === 0)
  const events = await fetch(gateway.url + "/api/events", { headers })
  assert.equal(events.status, 200)
  const reader = events.body.getReader()
  const decoder = new TextDecoder()
  let frames = ""
  const readHeartbeat = async () => {
    while (!frames.includes(": ping\n\n")) {
      const part = await reader.read()
      assert.equal(part.done, false)
      frames += decoder.decode(part.value, { stream: true })
    }
  }
  let timer
  try {
    await Promise.race([readHeartbeat(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SSE heartbeat timeout")), 3000) })])
    assert.equal(frames.split("\n").filter(line => line.startsWith("data: ")).length, 0)
    const live = await snapshot()
    assert.equal(live.events, 1)
    assert.equal(live.requests, 0)
    assert.equal(live.active, 1)
    assert.equal((await snapshot(gatewayToken + "-host")).active, 0)
  } finally { clearTimeout(timer); await reader.cancel() }
  await until(value => value.active === 0)
  const denied = await fetch(gateway.url + "/api/providers", { method: "POST", headers, body: "{}" })
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { error: { message: "insufficient_scope", code: "FORBIDDEN" } })
  assert.equal((await fetch(gateway.url + "/api/usage/logs?appId=release-battery", { headers })).status, 403)
  const tenant = await (await fetch(gateway.url + "/api/usage/summary", { headers })).json()
  assert.equal(tenant.summary.requests, 1)
  assert.equal(Math.round(tenant.summary.costLowUsd * 1_000_000), 11)
  assert.equal(hub.usage.query({ appId: "battery-tenant" }).total, 1)
  assert.equal(hub.usage.query().total, 2)
  assert.ok(!JSON.stringify(hub.usage.query({ appId: "" })).includes(gatewayToken), "gateway token leaked into usage data")
  await gateway.close()
  gateway = undefined
  const before = hub.usage.summary()
  const tomorrow = new Date(Date.now() + 2 * 86_400_000)
  const cutoffDate = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, "0"), String(tomorrow.getDate()).padStart(2, "0")].join("-")
  const archiveFile = join(consumerRoot, "usage-archive.jsonl")
  const archive = hub.usage.archive({ beforeDate: cutoffDate, targetFile: archiveFile })
  assert.equal(archive.records, 3)
  assert.equal(archive.costMicros, "33")
  const archiveText = readFileSync(archiveFile, "utf8")
  const boundary = archiveText.indexOf("\n")
  const header = JSON.parse(archiveText.slice(0, boundary))
  const body = archiveText.slice(boundary + 1)
  assert.equal(header.type, "mik-usage-archive")
  assert.equal(header.version, 1)
  assert.equal(header.before_date, cutoffDate)
  assert.equal(header.scope, "all-apps")
  assert.equal(header.records, 3)
  assert.equal(header.checksum.cost_micros, "33")
  assert.equal(header.sha256, createHash("sha256").update(body).digest("hex"))
  assert.equal(archive.sha256, header.sha256)
  assert.equal(body.trim().split("\n").reduce((sum, line) => sum + BigInt(JSON.parse(line).cost_micros), 0n), 33n)
  const archivedRows = body.trim().split("\n").map(line => JSON.parse(line))
  for (const field of ["cost_micros", "low_micros", "high_micros", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"]) {
    assert.equal(header.checksum[field], archivedRows.reduce((sum, row) => sum + BigInt(row[field]), 0n).toString())
  }
  assert.ok(!archiveText.includes(providerKey), "archive leaked provider key")
  assert.deepEqual(hub.usage.summary(), before)
  const vacuum = hub.usage.vacuum()
  assert.ok(Number.isSafeInteger(vacuum.beforeBytes) && Number.isSafeInteger(vacuum.afterBytes))
  assert.equal(vacuum.reclaimedBytes, vacuum.beforeBytes - vacuum.afterBytes)
  await hub.close()
  hub = undefined

  store = await Store.open({ path: dbPath })
  const providerRow = store.driver.prepare("SELECT api_key_ref FROM providers WHERE id = ?").get("mock")
  assert.equal(providerRow.api_key_ref, "env:MIK_RELEASE_BATTERY_KEY")
  const rolled = store.usage.rollup(Date.now() + 86_400_000)
  assert.equal(rolled, 0)
  const rollupRow = store.driver.prepare("SELECT cost_microusd FROM usage_daily_rollups WHERE app_id = ?").get("release-battery")
  assert.ok(rollupRow)
  assert.equal(Number(rollupRow.cost_microusd), 22)
  assert.ok(Number.isSafeInteger(Number(rollupRow.cost_microusd)))
  const tenantRollup = store.driver.prepare("SELECT cost_microusd FROM usage_daily_rollups WHERE app_id = ?").get("battery-tenant")
  assert.equal(Number(tenantRollup.cost_microusd), 11)
  assert.equal(store.driver.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 0)
  store.close(); store = undefined
  const cliEnv = { ...process.env, MIK_LANG: undefined, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }
  for (const args of [["db", "vacuum", "--db", dbPath, "--offline"], ["db", "archive", "--db", dbPath, "--before", cutoffDate, "--out", join(consumerRoot, "cli-archive.jsonl"), "--offline"]]) {
    const command = spawnSync(process.execPath, [cliEntry, ...args], { cwd: consumerRoot, encoding: "utf8", env: cliEnv, windowsHide: true })
    assert.equal(command.status, 0, redact(command.stderr))
  }
  assert.equal(JSON.parse(readFileSync(join(consumerRoot, "cli-archive.jsonl"), "utf8").split("\n")[0]).records, 0)
  console.log(JSON.stringify({ packageVersion: installedPackage.version, responseText: result.text, requests: summary.requests, costMicros: Number(rollupRow.cost_microusd), tenantCostMicros: Number(tenantRollup.cost_microusd), gatewayIsolation: true, smartRouter: true, archiveMicros: "33", vacuum: true, cliMaintenance: true, connectionLifecycle: true, sseComments: true }))
} finally {
  if (gateway) await gateway.close().catch(() => {})
  if (hub) await hub.close().catch(() => {})
  if (store) store.close()
  await new Promise((resolvePromise) => mock.close(() => resolvePromise()))
}
`
}

function evolutionSmokeSource() {
  return String.raw`import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import OpenAI from "openai"
import { ModelInfra, Store } from "model-infra-kit"
import { createServer as createGateway } from "model-infra-kit/server"

const root = process.cwd()
const env = { PROVIDER: "sk-battery-provider-123", ADMIN: "battery-admin-old", READER: "battery-reader" }
const calls = []
let held
let arrived
const arrival = new Promise(resolve => { arrived = resolve })
const chunk = (text, finish = null) => ({ id: "held", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })
const upstream = createServer(async (request, response) => {
  let raw = ""
  for await (const part of request) raw += part
  const body = JSON.parse(raw)
  calls.push({ path: request.url, authorization: request.headers.authorization, apiKey: request.headers["x-api-key"], marker: request.headers["x-mik-auto-protocol"] })
  assert.ok(request.headers.authorization === "Bearer " + env.PROVIDER || request.headers["x-api-key"] === env.PROVIDER)
  if (body.stream && request.url.startsWith("/old/")) {
    held = response
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: " + JSON.stringify(chunk("old-start")) + "\n\n")
    arrived()
    return
  }
  response.writeHead(200, { "content-type": "application/json" })
  const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
  if (request.url.endsWith("/responses")) {
    response.end(JSON.stringify({ id: "resp-battery", object: "response", created_at: 1, model: "mock-model", status: "completed", output: [{ type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "responses ok", annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }))
  } else if (request.url.endsWith("/messages")) {
    response.end(JSON.stringify({ id: "msg-battery", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "anthropic ok" }], usage: { input_tokens: 3, output_tokens: 4 } }))
  } else {
    response.end(JSON.stringify({ id: "chat-battery", object: "chat.completion", created: 1, model: "mock-model", choices: [{ index: 0, message: { role: "assistant", content: request.url.startsWith("/old/") ? "old-answer" : "new-answer" }, finish_reason: "stop" }], usage }))
  }
})
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve))
const port = upstream.address().port
const configPath = join(root, "reload.config.json")
const db = join(root, "evolution.db")
const options = { appId: "evolution", db, cacheDir: join(root, "evolution-cache"), maxRetries: 0, syncCatalog: false, pricingAutoSync: false, pricingFetch: async () => { throw new Error("offline") }, onWarn: () => {}, env }
const providers = path => [
  { id: "p", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:" + port + "/" + path, apiKeyRef: "env:PROVIDER" },
  { id: "a", protocol: "anthropic", baseUrl: "http://127.0.0.1:" + port + "/v1", apiKeyRef: "env:PROVIDER" },
]
const config = path => ({ providers: providers(path), defaultModel: "p:mock-model", serverTokens: [{ tokenRef: "env:ADMIN", scopes: ["admin"] }, { tokenRef: "env:READER", scopes: ["read:usage"] }] })
let hub
let gateway
let auto
let store
try {
  writeFileSync(configPath, JSON.stringify(config("old")))
  hub = await ModelInfra.init({ ...options, providers: providers("old"), defaultModel: "p:mock-model" })
  for (const modelId of ["mock-model", "claude-test"]) hub.pricing.setOverride({ modelId, inputPerM: 1, outputPerM: 2 })
  const event = appId => ({ requestId: crypto.randomUUID(), appId, ts: Date.now(), source: "test", providerId: "p", modelRequested: "mock-model", modelActual: "mock-model", traceId: "needle-trace", status: "ok", isStreaming: false, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: 0.000001, low: 0.000001, high: 0.000001, source: "override", basis: "manual" }, tags: { prompt: "needle timeout sk-battery-index-secret" } })
  hub.usage.record(event("evolution")); hub.usage.record(event("other-app"))
  const hits = hub.usage.searchTraces('needle AND timeout')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].event.appId, "evolution")
  assert.ok(hits[0].snippet.includes("\u0001"))
  assert.ok(!JSON.stringify(hits).includes("battery-index-secret"))
  assert.equal(hub.usage.withAppScope("other-app", () => hub.usage.searchTraces("needle", { appId: "evolution" }))[0].event.appId, "other-app")
  store = await Store.open({ path: db })
  const index = store.driver.prepare("SELECT * FROM usage_fts").all()
  assert.equal(index.length, 2)
  assert.ok(!JSON.stringify(index).includes("battery-index-secret"))
  store.close(); store = undefined
  gateway = await createGateway({ hub, port: 0, tokens: [{ token: env.ADMIN, scopes: ["admin"] }, { token: env.READER, scopes: ["read:usage"] }], reload: { configPath, hubOptions: options, env } })
  const send = (path, token = env.ADMIN, method = "GET", body) => fetch(gateway.url + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })
  assert.equal((await send("/api/reload", env.READER, "POST")).status, 403)
  const responsePromise = send("/v1/chat/completions", env.ADMIN, "POST", { model: "p:mock-model", stream: true, messages: [{ role: "user", content: "hello" }] })
  await Promise.race([arrival, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("held stream never arrived")), 5000); timer.unref() })])
  const heldBody = (await responsePromise).text()
  const oldAdmin = env.ADMIN
  env.ADMIN = "battery-admin-new"
  writeFileSync(configPath, JSON.stringify(config("new")))
  const reload = await send("/api/reload", oldAdmin, "POST")
  assert.equal(reload.status, 200)
  const reloadResult = await reload.json()
  assert.equal(reloadResult.reloaded, true)
  assert.ok(reloadResult.swapMicros >= 0)
  assert.equal((await send("/v1/models", oldAdmin)).status, 401)
  assert.equal((await (await send("/v1/chat/completions", env.ADMIN, "POST", { model: "p:mock-model", messages: [{ role: "user", content: "hi" }] })).json()).choices[0].message.content, "new-answer")
  writeFileSync(configPath, '{"invalid": "sk-battery-invalid-secret"')
  const invalid = await send("/api/reload", env.ADMIN, "POST")
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).reloaded, false)
  assert.equal((await (await send("/v1/chat/completions", env.ADMIN, "POST", { model: "p:mock-model", messages: [{ role: "user", content: "still works" }] })).json()).choices[0].message.content, "new-answer")
  held.end("data: " + JSON.stringify({ ...chunk("old-end", "stop"), usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }) + "\n\ndata: [DONE]\n\n")
  const text = await heldBody
  assert.ok(text.includes("old-start") && text.includes("old-end") && text.includes("[DONE]"))
  held = undefined
  process.env.MIK_GATEWAY_URL = gateway.url
  process.env.MIK_GATEWAY_TOKEN = env.ADMIN
  process.env.OPENAI_API_KEY = "sk-battery-sdk-caller"
  const originalFetch = globalThis.fetch
  const baseKeys = ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "DEEPSEEK_BASE_URL"]
  const before = baseKeys.map(key => process.env[key])
  auto = await import("model-infra-kit/auto")
  const sdk = new OpenAI()
  const answer = await sdk.chat.completions.create({ model: "mock-model", messages: [{ role: "user", content: "default SDK" }], seed: 42 })
  assert.equal(answer.choices[0].message.content, "new-answer")
  assert.equal((await sdk.responses.create({ model: "mock-model", input: "native responses" })).output_text, "responses ok")
  const native = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-battery-sdk-caller" }, body: JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "native" }], max_tokens: 10 }) })
  assert.equal(native.status, 200)
  assert.equal((await native.json()).content[0].text, "anthropic ok")
  auto.restore()
  assert.equal(globalThis.fetch, originalFetch)
  for (let i = 0; i < baseKeys.length; i++) assert.ok(process.env[baseKeys[i]] === before[i], "adapter-owned base URL restoration failed")
  assert.ok(calls.every(call => call.marker === undefined))
  assert.ok(calls.slice(-3).every(call => call.authorization === "Bearer " + env.PROVIDER || call.apiKey === env.PROVIDER))
  await gateway.close(); gateway = undefined
  await hub.close(); hub = undefined
  store = await Store.open({ path: db })
  const billed = store.driver.prepare("SELECT CAST(ROUND(cost_usd * 1000000) AS INTEGER) AS cost_micros FROM usage_events WHERE source <> 'test'").all()
  assert.equal(billed.length, 6)
  assert.ok(billed.every(row => String(row.cost_micros) === "11"))
  assert.equal(billed.reduce((sum, row) => sum + BigInt(row.cost_micros), 0n), 66n)
  const stored = store.driver.prepare("SELECT * FROM usage_events").all()
  assert.ok(!JSON.stringify(stored).includes(env.ADMIN))
  assert.ok(!JSON.stringify(stored).includes(env.PROVIDER))
  console.log(JSON.stringify({ ftsScoped: true, redactedIndex: true, snippets: true, reloadContinuity: true, invalidReloadSafe: true, adminRotation: true, defaultOpenAiSdk: true, nativeResponses: true, nativeAnthropic: true, restore: true, requests: billed.length, costMicros: "66" }))
} finally {
  auto?.restore()
  held?.end()
  if (gateway) await gateway.close()
  if (hub) await hub.close()
  if (store) store.close()
  await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
}
`
}

async function main() {
  if (process.argv.includes("--self-test-auto")) {
    autoArtifactFailureSelfCheck()
    process.exitCode = 1
    return
  }
  if (process.argv.includes("--self-test-contract")) {
    contractFailureSelfCheck()
    process.exitCode = 1
    return
  }
  const expected = contractFromDocs()
  const sourcePackageJson = readJson(PACKAGE_JSON_PATH)
  assert.equal(sourcePackageJson.name, "model-infra-kit")
  assert.equal(readJson(join(REPO_ROOT, "package.json")).version, "1.4.0", "root release version mismatch")
  assert.equal(sourcePackageJson.version, "1.4.0", "package release version mismatch")
  assertAbsoluteCwd(REPO_ROOT, "repository")
  assertAbsoluteCwd(PACKAGE_ROOT, "package")

  // ponytail: overwrite dist without deleting prior generated files; the tarball whitelist and exports are checked below.
  const build = await run("pnpm", ["--filter", "model-infra-kit", "build", "--no-clean"], { cwd: REPO_ROOT, label: "package build", printOutput: false })
  await loadProjectRedactor()
  process.stdout.write(projectRedact(build.stdout))
  process.stderr.write(projectRedact(build.stderr))

  const cleanRoom = mkdtempSync(join(tmpdir(), "mik-release-battery-"))
  assertInside(tmpdir(), cleanRoom, "clean room")
  const packDir = join(cleanRoom, "candidate")
  const extractDir = join(cleanRoom, "extract")
  const consumerDir = join(cleanRoom, "consumer")
  mkdirSync(packDir, { recursive: true })
  mkdirSync(extractDir, { recursive: true })
  mkdirSync(consumerDir, { recursive: true })
  process.stdout.write(`[clean-room] retained=${cleanRoom}\n`)

  await run("npm", ["pack", "--pack-destination", packDir, "--json"], { cwd: PACKAGE_ROOT, label: "npm pack" })
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"))
  assert.equal(tarballs.length, 1, `expected one candidate tarball in ${packDir}`)
  const tarballPath = join(packDir, tarballs[0])
  assert.ok(existsSync(tarballPath), `candidate tarball missing: ${tarballPath}`)
  process.stdout.write(`[candidate] ${tarballPath}\n`)

  await run("tar", ["-xzf", tarballPath, "-C", extractDir], { cwd: extractDir, label: "clean-room extract" })
  const packedRoot = join(extractDir, "package")
  assert.ok(existsSync(packedRoot), `tarball did not extract package root: ${packedRoot}`)
  assertInside(cleanRoom, packedRoot, "packed package")
  const packedPackageJson = readJson(join(packedRoot, "package.json"))
  assert.equal(packedPackageJson.name, sourcePackageJson.name)
  assert.equal(packedPackageJson.version, sourcePackageJson.version)
  checkPackageFiles(packedRoot, packedPackageJson)

  const consumerDirPackageJson = join(consumerDir, "package.json")
  writeAbsolute(consumerDirPackageJson, JSON.stringify({ name: "mik-release-battery-consumer", private: true, type: "module" }, null, 2) + "\n")
  const smokePath = join(consumerDir, "smoke.mjs")
  writeAbsolute(smokePath, smokeSource())
  const runtimeExportsPath = join(consumerDir, "runtime-exports.mjs")
  writeAbsolute(runtimeExportsPath, installedRuntimeSource())
  const batteryKey = `release-battery-${process.pid}-${Date.now()}`
  const smokeEnv = { ...process.env, MIK_RELEASE_BATTERY_KEY: batteryKey, MIK_BATTERY_EXPECTED_VERSION: sourcePackageJson.version }
  await run("pnpm", ["add", "--save-exact", "--ignore-scripts", tarballPath, "@ai-sdk/openai-compatible@3.0.45", "openai@7.12.1"], {
    cwd: consumerDir,
    label: "consumer pnpm install",
    env: smokeEnv,
    redactSecrets: [batteryKey],
  })
  const runtimeExports = await run("node", [runtimeExportsPath], {
    cwd: consumerDir,
    label: "installed runtime export contract",
    env: smokeEnv,
    redactSecrets: [batteryKey],
  })
  const runtimeOutput = runtimeExports.stdout.trim().split(/\r?\n/).at(-1)
  assert.ok(runtimeOutput, "installed runtime export check produced no JSON output")
  const installedExports = JSON.parse(runtimeOutput)
  for (const entrypoint of EXPECTED_ENTRYPOINTS) compareExports(entrypoint, expected[entrypoint], installedExports[entrypoint] ?? [])
  await run("node", [smokePath], {
    cwd: consumerDir,
    label: "consumer generate and integer-micros smoke",
    env: smokeEnv,
    redactSecrets: [batteryKey],
  })
  const evolutionPath = join(consumerDir, "evolution-smoke.mjs")
  writeAbsolute(evolutionPath, evolutionSmokeSource())
  await run("node", [evolutionPath], { cwd: consumerDir, label: "installed FTS, reload and default SDK smoke", env: smokeEnv, redactSecrets: [batteryKey] })
  process.stdout.write(`[result] release battery passed; retained clean room=${cleanRoom}\n`)
}

main().catch((error) => {
  process.stderr.write(`[release-battery] FAILED: ${projectRedact(error instanceof Error ? error.message : String(error))}\n`)
  process.exitCode = 1
})

