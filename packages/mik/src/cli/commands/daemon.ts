import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createConnection, createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { defaultHomeDir } from "../../util/paths.js"
import { redact } from "../../util/redact.js"
import { flagNumber, flagString, parseCliArgs, type ParsedCli } from "../args.js"
import { invocationLang, resolveCwd, resolveEnv, resolveIo, type RunOptions } from "../context.js"
import { CliRuntimeError } from "../errors.js"
import { portInUse, assertPortFree } from "../ports.js"
import { tr } from "../i18n.js"
import { runServe } from "./serve.js"

interface DaemonState {
  pid: number
  startedAt: number
  pipe: string
  port: number
  args: string[]
  state: "running" | "stopped"
}
interface Health { pid: number; startedAt: number; port: number; rss: number }
const WAIT_MS = 15_000

export function daemonStatePath(options: RunOptions): string {
  return resolve(resolveCwd(options), resolveEnv(options).MIK_DAEMON_FILE ?? join(defaultHomeDir(), "daemon.json"))
}
function stateAt(path: string): DaemonState | undefined {
  if (!existsSync(path)) return undefined
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as DaemonState
    if (!Number.isSafeInteger(state.pid) || state.pid < 1 || !Number.isSafeInteger(state.startedAt) || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || typeof state.pipe !== "string" || !Array.isArray(state.args) || !state.args.every(arg => typeof arg === "string") || !["running", "stopped"].includes(state.state)) throw new Error()
    return state
  } catch { throw new CliRuntimeError("Invalid daemon state file; refusing to signal a process.") }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}
/** Compare the process's own identity, rather than trusting a reusable PID. */
export function daemonControl(state: DaemonState, action: "status" | "stop"): Promise<Health> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(state.pipe)
    let data = ""
    const fail = (error: Error) => { socket.destroy(); reject(error) }
    socket.setTimeout(2000, () => fail(new CliRuntimeError("Daemon control timed out.")))
    socket.once("error", fail)
    socket.once("connect", () => socket.write(JSON.stringify({ action, pid: state.pid, startedAt: state.startedAt }) + "\n"))
    socket.on("data", chunk => {
      data += chunk.toString()
      if (data.length > 4096) { fail(new CliRuntimeError("Invalid daemon control response.")); return }
      if (!data.includes("\n")) return
      try {
        const health = JSON.parse(data.trim()) as Health
        if (health.pid !== state.pid || health.startedAt !== state.startedAt || health.port !== state.port || !Number.isSafeInteger(health.rss) || health.rss < 0) throw new Error()
        socket.destroy(); resolve(health)
      } catch { fail(new CliRuntimeError("Daemon process identity mismatch; no signal sent.")) }
    })
    socket.once("end", () => { if (!data) fail(new CliRuntimeError("Daemon control closed without a response.")) })
  })
}
function cliEntry(): string {
  for (const relative of ["./cli.mjs", "../cli.mjs", "../../../dist/cli.mjs"]) {
    const candidate = fileURLToPath(new URL(relative, import.meta.url))
    if (existsSync(candidate)) return candidate
  }
  throw new CliRuntimeError("Build the CLI before starting a daemon.")
}

function serveArgs(parsed: ParsedCli): string[] {
  const args = ["--port", String(flagNumber(parsed.values, "port") ?? 3211)]
  for (const [key, flag] of [["db", "db"], ["config", "config"], ["cacheDir", "cache-dir"], ["appId", "app-id"]]) {
    const value = flagString(parsed.values, key!)
    if (value !== undefined) args.push(`--${flag}`, value)
  }
  if (parsed.values.offline) args.push("--offline")
  return args
}

async function worker(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const env = resolveEnv(options)
  const startedAt = Number(env.MIK_DAEMON_STARTED_AT)
  const pipe = env.MIK_DAEMON_PIPE!
  if (!process.send || !Number.isSafeInteger(startedAt) || !pipe) throw new CliRuntimeError("Daemon worker requires its parent IPC channel.")
  let listening = false
  let detached = false
  let parentGone = false
  const detach = (message: unknown) => { if (message && typeof message === "object" && "action" in message && message.action === "detach") detached = true }
  const disconnected = () => { parentGone = !detached; if (parentGone && listening) process.emit("SIGTERM") }
  process.on("message", detach)
  process.once("disconnect", disconnected)
  const control = createServer(socket => {
    let data = ""
    socket.setTimeout(2000, () => socket.destroy())
    socket.on("error", () => socket.destroy())
    socket.on("data", chunk => {
      data += chunk.toString()
      if (data.length > 4096) { socket.destroy(); return }
      if (!data.includes("\n")) return
      try {
        const command = JSON.parse(data.trim())
        socket.removeAllListeners("data")
        if (command.pid !== process.pid || command.startedAt !== startedAt || !["status", "stop"].includes(command.action)) { socket.destroy(); return }
        const port = flagNumber(parsed.values, "port") ?? 3211
        socket.end(JSON.stringify({ pid: process.pid, startedAt, port, rss: process.memoryUsage().rss }) + "\n")
        if (command.action === "stop") process.emit("SIGTERM")
      } catch { socket.destroy() }
    })
  })
  const args = serveArgs(parsed)
  try {
    return await runServe(parseCliArgs(["serve", ...args]), { ...options, onServeReady: async () => {
      await new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(pipe, resolve) })
      listening = true
      if (parentGone) process.emit("SIGTERM")
      else process.send!({ pid: process.pid, startedAt, port: flagNumber(parsed.values, "port") ?? 3211 })
    } })
  } finally {
    process.off("message", detach)
    process.off("disconnect", disconnected)
    if (listening) await new Promise<void>(resolve => control.close(() => resolve()))
  }
}

export async function runDaemon(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const env = resolveEnv(options)
  if (env.MIK_DAEMON_WORKER === "1") {
    try { return await worker(parsed, options) } catch (error) {
      if (process.connected) process.send?.({ error: redact(error instanceof Error ? error.message : String(error)) })
      throw error
    }
  }
  const io = resolveIo(options)
  const lang = invocationLang(options)
  const path = daemonStatePath(options)
  const action = parsed.action!.name
  let state = stateAt(path)
  if (action === "status") {
    if (!state || state.state === "stopped" || !alive(state.pid)) { io.out(tr(lang, "daemon.stopped")); return 0 }
    const health = await daemonControl(state, "status")
    io.out(redact(JSON.stringify({ state: "running", ...health, listening: await portInUse(state.port) })))
    return 0
  }
  mkdirSync(dirname(path), { recursive: true })
  const lock = `${path}.lock`
  try { mkdirSync(lock) } catch { throw new CliRuntimeError("Daemon lifecycle is locked; inspect the existing lock before retrying.") }
  try {
    state = stateAt(path)
    if (action === "stop") {
      if (!state || state.state === "stopped" || !alive(state.pid)) { io.out(tr(lang, "daemon.stopped")); return 0 }
      await daemonControl(state, "stop")
      const deadline = Date.now() + WAIT_MS
      while (alive(state.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
      if (alive(state.pid)) throw new CliRuntimeError("Daemon did not exit within 15 seconds; no force kill performed.")
      writeFileSync(path, JSON.stringify({ ...state, state: "stopped" }), { mode: 0o600 })
      io.out(tr(lang, "daemon.stopped"))
      return 0
    }
    if (state?.state === "running" && alive(state.pid)) {
      await daemonControl(state, "status")
      throw new CliRuntimeError(tr(lang, "daemon.alreadyRunning"))
    }
    const port = flagNumber(parsed.values, "port", parsed.action?.usage, lang) ?? 3211
    await assertPortFree(port, "daemon", lang)
    const id = randomUUID()
    const pipe = process.platform === "win32" ? `\\\\.\\pipe\\mik-daemon-${id}` : join(tmpdir(), `mik-daemon-${id}.sock`)
    const startedAt = Date.now()
    const args = ["daemon", "start", ...serveArgs(parsed)]
    const child = spawn(process.execPath, [cliEntry(), ...args], { cwd: resolveCwd(options), env: { ...env, MIK_DAEMON_WORKER: "1", MIK_DAEMON_PIPE: pipe, MIK_DAEMON_STARTED_AT: String(startedAt) }, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new CliRuntimeError("Daemon startup timed out after 15 seconds.")), WAIT_MS)
        const finish = (error?: Error) => { clearTimeout(timer); child.off("exit", exited); child.off("error", failed); child.off("message", ready); error ? reject(error) : resolve() }
        const exited = () => finish(new CliRuntimeError("Daemon exited before it was ready."))
        const failed = (error: Error) => finish(error)
        const ready = (message: unknown) => {
          if (message && typeof message === "object" && "error" in message && typeof message.error === "string") {
            finish(new CliRuntimeError(redact(message.error)))
            return
          }
          const health = message as Health
          if (health.pid !== child.pid || health.startedAt !== startedAt || health.port !== port) { finish(new CliRuntimeError("Invalid daemon readiness response.")); return }
          finish()
        }
        child.once("exit", exited); child.once("error", failed); child.once("message", ready)
      })
      writeFileSync(path, JSON.stringify({ pid: child.pid!, startedAt, pipe, port, args: args.slice(2), state: "running" } satisfies DaemonState), { mode: 0o600 })
      await new Promise<void>((resolve, reject) => child.send({ action: "detach" }, error => error ? reject(error) : resolve()))
      io.out(tr(lang, "daemon.started", child.pid!, port))
    } catch (error) {
      if (child.pid && alive(child.pid)) {
        try { await daemonControl({ pid: child.pid, startedAt, pipe, port, args: [], state: "running" }, "stop") } catch { child.kill("SIGTERM") }
      }
      throw error
    } finally { if (child.connected) child.disconnect(); child.unref() }
    return 0
  } finally {
    // Keep released locks recoverable; no filesystem deletion is needed.
    renameSync(lock, `${lock}.${randomUUID()}.released`)
  }
}
