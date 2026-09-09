import { execFile } from "node:child_process"
import { connect } from "node:net"
import { promisify } from "node:util"
import { CliRuntimeError } from "./errors.js"

const execFileAsync = promisify(execFile)

export interface PortProbe {
  port: number
  inUse: boolean
  /** `netstat` is the required check; `tcp` is only a fallback when it is absent. */
  source: "netstat" | "tcp"
}

/**
 * `netstat -ano | findstr :<port>` equivalent, done in-process.
 *
 * A port is taken when the OS reports a listener on it; TIME_WAIT entries are
 * ignored because the question is "may I bind this?" for a fresh server.
 */
export function netstatShowsPort(output: string, port: number): boolean {
  for (const line of output.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    // Local addresses look like `127.0.0.1:3211`, `0.0.0.0:3211` or `[::]:3211`.
    for (const match of line.matchAll(/:(\d+)(?=\s|$)/g)) {
      if (Number(match[1]) === port) return true
    }
  }
  return false
}

function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" })
    const finish = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(1000)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

export async function probePort(port: number): Promise<PortProbe> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano"], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
    })
    return { port, inUse: netstatShowsPort(stdout, port), source: "netstat" }
  } catch {
    // netstat is missing (some containers) — fall back to a real connect.
    return { port, inUse: await tcpProbe(port), source: "tcp" }
  }
}

export async function portInUse(port: number): Promise<boolean> {
  return (await probePort(port)).inUse
}

/**
 * Refuse to start a service on a taken port. The project rule is to report and
 * exit rather than steal a port another project is already using.
 */
export async function assertPortFree(port: number, command: string): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliRuntimeError(`Invalid port ${port}. Use an integer between 1 and 65535.`)
  }
  const probe = await probePort(port)
  if (probe.inUse) {
    throw new CliRuntimeError(
      `Port ${port} is already in use (checked with netstat -ano). ` +
        `Free it or run "mik ${command} --port <other-port>". Refusing to start.`,
    )
  }
}
