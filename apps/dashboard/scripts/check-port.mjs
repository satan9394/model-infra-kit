// Port guard for `pnpm dev` / `pnpm start`.
//
// AGENTS.md: the dashboard owns 3210 and must fail loudly instead of stealing a
// port. `next dev` would happily pick 3211 by itself, so this runs first and
// exits non-zero when something is already listening.
//
// Port resolution, highest priority first:
//   1. process.argv[2]  — `pnpm dev` / `pnpm start` pass 3210 explicitly
//   2. PORT             — honoured only when no positional argument is given
//   3. 3210             — AGENTS.md default
// Host resolution: process.argv[3], otherwise 127.0.0.1.
import { createConnection } from "node:net"

const DEFAULT_PORT = 3210
const DEFAULT_HOST = "127.0.0.1"

const argPort = process.argv[2]
const envPort = process.env.PORT

let portSource
let rawPort
if (argPort !== undefined && argPort !== "") {
  portSource = "命令行参数 argv[2]"
  rawPort = argPort
} else if (envPort !== undefined && envPort !== "") {
  portSource = "环境变量 PORT"
  rawPort = envPort
} else {
  portSource = "默认值 3210"
  rawPort = String(DEFAULT_PORT)
}

const port = Number(rawPort)
const host = process.argv[3] ?? DEFAULT_HOST

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`\n端口无效：${rawPort}（来自${portSource}），需要 1-65535 的整数。`)
  console.error(`用法：node scripts/check-port.mjs [端口] [主机]`)
  console.error(`      PORT=<端口> node scripts/check-port.mjs\n`)
  process.exit(1)
}

function inUse(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1000)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

if (await inUse(port, host)) {
  console.error(`\n端口 ${port} 已被占用（${host}）。看板不会硬抢端口。`)
  console.error(`端口来源：${portSource}`)
  console.error(`查看占用：netstat -ano | findstr :${port}`)
  console.error(`换端口：node scripts/check-port.mjs <新端口>，或 PORT=<新端口> node scripts/check-port.mjs`)
  console.error(`注意：pnpm dev / pnpm start 在 package.json 里固定传了 3210，`)
  console.error(`      那种情况下 PORT 不生效，要同时改那两个脚本里的端口参数。\n`)
  process.exit(1)
}

console.log(`端口 ${port} 可用（${host}）。`)
