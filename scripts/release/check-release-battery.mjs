#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, "../..")
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "mik")
const PACKAGE_JSON_PATH = join(PACKAGE_ROOT, "package.json")
const CONTRACT_MARKER = "<!-- release-battery-runtime-exports:v1 -->"
const EXPECTED_ENTRYPOINTS = [".", "./cli", "./server"]

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

let projectRedact = (text) => text

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
  process.stderr.write("[self-test] deliberate runtime export mismatch detected; exit code 1 is expected\n")
}

function installedRuntimeSource() {
  return String.raw`import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { resolve, sep } from "node:path"

const root = resolve(process.cwd())
const packageJson = fileURLToPath(await import.meta.resolve("model-infra-kit/package.json"))
assert.ok(packageJson.startsWith(root + sep), "installed package resolved outside the clean consumer directory")
const entries = [[".", "model-infra-kit"], ["./server", "model-infra-kit/server"], ["./cli", "model-infra-kit/cli"]]
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
import { ModelInfra, Store } from "model-infra-kit"
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
  const gatewayToken = providerKey + "-gateway"
  gateway = await createGateway({ hub, port: 0, tokens: [{ token: gatewayToken, scopes: ["write:chat", "read:usage"], appId: "battery-tenant" }] })
  const headers = { authorization: "Bearer " + gatewayToken, "content-type": "application/json" }
  const chat = await fetch(gateway.url + "/v1/chat/completions", { method: "POST", headers,
    body: JSON.stringify({ model: "mock:mock-model", messages: [{ role: "user", content: "tenant hello" }] }) })
  assert.equal(chat.status, 200)
  assert.equal((await chat.json()).choices[0].message.content, "battery ok")
  const denied = await fetch(gateway.url + "/api/providers", { method: "POST", headers, body: "{}" })
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { error: { message: "insufficient_scope", code: "FORBIDDEN" } })
  assert.equal((await fetch(gateway.url + "/api/usage/logs?appId=release-battery", { headers })).status, 403)
  const tenant = await (await fetch(gateway.url + "/api/usage/summary", { headers })).json()
  assert.equal(tenant.summary.requests, 1)
  assert.equal(Math.round(tenant.summary.costLowUsd * 1_000_000), 11)
  assert.equal(hub.usage.query({ appId: "battery-tenant" }).total, 1)
  assert.equal(hub.usage.query().total, 1)
  assert.ok(!JSON.stringify(hub.usage.query({ appId: "" })).includes(gatewayToken), "gateway token leaked into usage data")
  await gateway.close()
  gateway = undefined
  await hub.close()
  hub = undefined

  store = await Store.open({ path: dbPath })
  const providerRow = store.driver.prepare("SELECT api_key_ref FROM providers WHERE id = ?").get("mock")
  assert.equal(providerRow.api_key_ref, "env:MIK_RELEASE_BATTERY_KEY")
  const rolled = store.usage.rollup(Date.now() + 86_400_000)
  assert.equal(rolled, 2)
  const rollupRow = store.driver.prepare("SELECT cost_microusd FROM usage_daily_rollups WHERE app_id = ?").get("release-battery")
  assert.ok(rollupRow)
  assert.equal(Number(rollupRow.cost_microusd), 11)
  assert.ok(Number.isSafeInteger(Number(rollupRow.cost_microusd)))
  const tenantRollup = store.driver.prepare("SELECT cost_microusd FROM usage_daily_rollups WHERE app_id = ?").get("battery-tenant")
  assert.equal(Number(tenantRollup.cost_microusd), 11)
  console.log(JSON.stringify({ packageVersion: installedPackage.version, responseText: result.text, requests: summary.requests, costMicros: Number(rollupRow.cost_microusd), tenantCostMicros: Number(tenantRollup.cost_microusd), gatewayIsolation: true }))
} finally {
  if (gateway) await gateway.close().catch(() => {})
  if (hub) await hub.close().catch(() => {})
  if (store) store.close()
  await new Promise((resolvePromise) => mock.close(() => resolvePromise()))
}
`
}

async function main() {
  if (process.argv.includes("--self-test-contract")) {
    contractFailureSelfCheck()
    process.exitCode = 1
    return
  }
  const expected = contractFromDocs()
  const sourcePackageJson = readJson(PACKAGE_JSON_PATH)
  assert.equal(sourcePackageJson.name, "model-infra-kit")
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
  await run("pnpm", ["add", "--save-exact", "--ignore-scripts", tarballPath, "@ai-sdk/openai-compatible@3.0.45"], {
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
  process.stdout.write(`[result] release battery passed; retained clean room=${cleanRoom}\n`)
}

main().catch((error) => {
  process.stderr.write(`[release-battery] FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

