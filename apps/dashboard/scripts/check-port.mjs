// Port guard for `pnpm dev` / `pnpm start`.
//
// AGENTS.md: the dashboard owns 3210 and must fail loudly instead of stealing a
// port. `next dev` would happily pick 3211 by itself, so this runs first and
// exits non-zero when something is already listening.
import { createConnection } from "node:net"

const port = Number(process.argv[2] ?? "3210")
const host = process.argv[3] ?? "127.0.0.1"

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
  console.error(`查看占用：netstat -ano | findstr :${port}`)
  console.error(`换端口：PORT=<新端口> 或修改 apps/dashboard/package.json 的 -p 参数。\n`)
  process.exit(1)
}

console.log(`端口 ${port} 可用（${host}）。`)
