#!/usr/bin/env node
/**
 * Three-environment regression battery for model-infra-kit.
 *
 * Runs an offline battery — CLI bin entry (direct + npm symlink regression on
 * Unix), `mik serve`, the OpenAI-compatible endpoint, usage recording, CSV
 * export and the python host — in each environment that is available on this
 * machine: Windows PowerShell, Git Bash, WSL2 Ubuntu.
 *
 * Usage:
 *   node scripts/check-envs.mjs [options]
 *     --only <a,b,c>       run only these environments (powershell,git-bash,wsl-ubuntu)
 *     --skip <a,b>         skip these environments
 *     --json               machine-readable JSON report on stdout
 *     --timeout <ms>       per-environment timeout (default 300_000)
 *     --build              force a rebuild before running
 *     --help               this help
 *
 * Exit codes: 0 all ran and passed · 1 at least one ran and failed
 *             (skipped environments never fail the run) · 2 usage/setup error
 *
 * Env overrides: MIK_GIT_BASH=<path to bash.exe> when Git Bash lives elsewhere.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const BATTERY_SH = join(ROOT, "scripts", "check-envs", "battery.sh")
const BATTERY_PS1 = join(ROOT, "scripts", "check-envs", "battery.ps1")
const VALID_ENVS = ["powershell", "git-bash", "wsl-ubuntu"]

function usage() {
  console.log(`check-envs — 三环境离线回归电池
用法: node scripts/check-envs.mjs [--only a,b,c] [--skip a,b] [--json] [--timeout ms] [--build] [--help]
环境: ${VALID_ENVS.join(", ")}
退出码: 0 全部通过 · 1 有失败 · 2 用法/准备错误`)
}

function parseArgs(argv) {
  const args = { only: null, skip: [], json: false, timeout: 300_000, build: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--help" || a === "-h") { usage(); process.exit(0) }
    if (a === "--only") args.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--skip") args.skip = args.skip.concat((argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean))
    else if (a === "--json") args.json = true
    else if (a === "--build") args.build = true
    else if (a === "--timeout") args.timeout = Number(argv[++i]) || 300_000
    else { console.error(`未知参数: ${a}（--help 查看用法）`); process.exit(2) }
  }
  const unknown = [...(args.only ?? []), ...args.skip].filter((e) => !VALID_ENVS.includes(e))
  if (unknown.length > 0) {
    console.error(`未知环境: ${unknown.join(", ")}（可选: ${VALID_ENVS.join(", ")}）`)
    process.exit(2)
  }
  return args
}

function ensureDist(force) {
  const cli = join(ROOT, "packages", "mik", "dist", "cli.mjs")
  if (!force && existsSync(cli)) return
  console.log("dist 不存在或 --build 指定，构建 …")
  const build = spawnSync("pnpm", ["--filter", "model-infra-kit", "build"], { encoding: "utf8", cwd: ROOT, timeout: 300_000 })
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout || "build failed")
    process.exit(2)
  }
}

/** Port availability probe on 127.0.0.1. */
function portFree(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
    const done = (free) => { socket.destroy(); resolve(free) }
    socket.setTimeout(800)
    socket.once("connect", () => done(false))
    socket.once("error", () => done(true))
    socket.once("timeout", () => done(true))
  })
}

/** First free port at or above `from`. */
async function pickPort(from) {
  for (let port = from; port < from + 60; port += 1) {
    if (await portFree(port)) return port
  }
  return from
}

/** `E:\a\b` → `/e/a/b` (msys) and `/mnt/e/a/b` (WSL). */
function unixRoot(style) {
  const win = ROOT.replace(/\\/g, "/")
  const drive = win[0].toLowerCase()
  const rest = win.slice(2)
  return style === "wsl" ? `/mnt/${drive}${rest}` : `/${drive}${rest}`
}

function findGitBash() {
  const candidates = [
    process.env.MIK_GIT_BASH,
    "D:\\Technology_application\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ].filter(Boolean)
  return candidates.find(existsSync) ?? null
}

function findWslUbuntu() {
  const out = spawnSync("wsl", ["-l", "-q"], { encoding: "utf8" }).stdout || ""
  return /Ubuntu/i.test(out.replace(/\u0000/g, ""))
}

/** Marker lines emitted by the batteries: `STEP <name> ok|fail` (CR-tolerant). */
const STEP_RE = /^STEP\s+(\S+)\s+(ok|fail)\s*\r?$/

function which(cmd) {
  const r = spawnSync("where.exe", [cmd], { encoding: "utf8" })
  if (r.status === 0) {
    const first = (r.stdout || "").trim().split(/\r?\n/)[0]
    if (first) return first
  }
  return cmd
}

async function runEnv(env, timeout) {
  if (env.id === "powershell") {
    const pwsh = which("pwsh")
    const db = join(tmpdir(), `mik-env-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    return spawnEnv("powershell", pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BATTERY_PS1, "powershell", ROOT, String(env.ports.serve), String(env.ports.mock), db], timeout)
  }
  if (env.id === "git-bash") {
    const bash = findGitBash()
    if (!bash) return { ok: null, reason: "未找到 Git Bash（用 MIK_GIT_BASH 指定）" }
    const gbRoot = unixRoot("msys")
    const gbTarget = `${ROOT.replace(/\\/g, "/")}/packages/mik/dist/cli.mjs`
    const gbDb = join(tmpdir(), `mik-env-gb-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    return spawnEnv("git-bash", bash, ["-lc", `bash "${gbRoot}/scripts/check-envs/battery.sh" git-bash ${gbRoot} ${env.ports.serve} ${env.ports.mock} "${gbDb}" "${gbTarget}" skip`], timeout)
  }
  if (env.id === "wsl-ubuntu") {
    if (!findWslUbuntu()) return { ok: null, reason: "未找到 WSL Ubuntu（wsl -l -q）" }
    const wslRoot = unixRoot("wsl")
    const db = `/tmp/mik-env-wsl-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    return spawnEnv("wsl-ubuntu", "wsl", ["-d", "Ubuntu", "--", "bash", `${wslRoot}/scripts/check-envs/battery.sh`, "wsl-ubuntu", wslRoot, String(env.ports.serve), String(env.ports.mock), db, `${wslRoot}/packages/mik/dist/cli.mjs`], timeout)
  }
  return { ok: false, reason: `未实现的 env: ${env.id}` }
}

async function spawnEnv(label, cmd, args, timeout) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    const timer = setTimeout(() => { child.kill(); out += "\n[TIMEOUT]\n" }, timeout)
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ label, ok: false, code: null, steps: [], out: `[spawn error] ${err.message}`, failedStep: "spawn" })
    })
    child.stdout.on("data", (c) => (out += c))
    child.stderr.on("data", (c) => (out += c))
    child.on("close", (code) => {
      clearTimeout(timer)
      const steps = []
      for (const line of out.split("\n")) {
        const m = STEP_RE.exec(line)
        if (m) steps.push({ name: m[1], ok: m[2] === "ok" })
      }
      const failedStep = steps.find((s) => !s.ok)
      const ok = code === 0 && !failedStep
      resolve({ label, ok, code, steps, out, failedStep: failedStep?.name ?? null })
    })
  })
}

/** Fresh, distinct ports for one environment (a retry must not reuse a stale pair). */
async function freshPorts(id) {
  const from = { "powershell": [3350, 3360], "git-bash": [3450, 3460], "wsl-ubuntu": [3550, 3560] }[id] ?? [3350, 3360]
  let serve = await pickPort(from[0])
  let mock = await pickPort(from[1])
  // pickPort may fall back to its `from` value when everything above is busy;
  // keep the pair distinct without wandering into another environment's range.
  if (mock === serve) mock = await pickPort(serve + 1)
  return { serve, mock }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  ensureDist(args.build)
  const work = mkdtempSync(join(tmpdir(), "mik-envs-"))
  try {
    const wanted = (args.only ?? VALID_ENVS).filter((id) => !args.skip.includes(id))
    const ports = {}
    // Allocate sequentially per env to keep them distinct.
    for (const id of wanted) ports[id] = await freshPorts(id)

    const results = []
    for (const id of wanted) {
      let result = await runEnv({ id, ports: ports[id] }, args.timeout)
      // G23: a single bounded retry for *failures only* (never for SKIPs). A
      // transient port/process hiccup then shows up as `PASS (retried)`; a real
      // failure survives the retry and still fails the run.
      if (result.ok === false) {
        ports[id] = await freshPorts(id)
        const retry = await runEnv({ id, ports: ports[id] }, args.timeout)
        retry.retried = true
        retry.firstAttempt = { code: result.code, failedStep: result.failedStep }
        result = retry
      }
      results.push(result)
    }

    if (args.json) {
      console.log(JSON.stringify({ exit: results.some((r) => r.ok === false) ? 1 : 0, results: results.map((r) => ({ label: r.label, status: r.ok === true ? "PASS" : r.ok === null ? "SKIP" : "FAIL", retried: r.retried === true, code: r.code ?? null, failedStep: r.failedStep, reason: r.ok === null ? r.reason ?? "" : "", outputTail: r.out?.trim().split("\n").slice(-8) ?? [] })) }, null, 2))
      // `--json` is the CI-facing mode: it must carry the same exit status as the
      // human path, or a failing run would look green to a pipeline.
      process.exit(results.some((r) => r.ok === false) ? 1 : 0)
    }

    let failed = 0
    let retried = 0
    for (const r of results) {
      const status = r.ok === true ? "PASS" : r.ok === null ? "SKIP" : "FAIL"
      const label = r.ok === true && r.retried ? `${status} (retried)` : status
      if (r.ok === false) failed += 1
      if (r.ok === true && r.retried) retried += 1
      console.log(`${label.padEnd(4)} ${r.label}${r.ok === null && r.reason ? `  (${r.reason})` : ""}`)
      // A retry that *succeeds* still has to leave a diagnostic trail: the whole
      // point of surfacing `PASS (retried)` is to make the flake visible, and a
      // flake with no recorded first failure cannot be investigated.
      if (r.ok === true && r.retried) {
        console.log(`      首次失败: ${r.firstAttempt?.failedStep ?? "(未知)"}（code ${r.firstAttempt?.code ?? "n/a"}），重试后通过`)
      }
      if (r.ok === false) {
        if (r.retried) console.log(`      首次失败: ${r.firstAttempt?.failedStep ?? "(未知)"}（code ${r.firstAttempt?.code ?? "n/a"}），重试后仍失败`)
        console.log(`      第一步失败: ${r.failedStep ?? "(未知)"}`)
        const tail = r.out.trim().split("\n").slice(-14).join("\n")
        console.log(indent(tail))
      }
    }
    const summary = failed === 0 ? (retried > 0 ? `\n全部环境通过（其中 ${retried} 个在重试后通过）。` : "\n全部环境通过。") : `\n${failed} 个环境失败${retried > 0 ? `（另有 ${retried} 个在重试后通过）` : ""}。`
    console.log(summary)
    process.exit(failed === 0 ? 0 : 1)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}

main()