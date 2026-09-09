// Launcher for the upstream `mik serve` HTTP API.
//
// Why this exists: `packages/mik/dist/cli.mjs serve` currently cannot load its
// own server bundle (the CLI resolves `../server.mjs` relative to `dist/`, which
// points outside the package), so `mik serve` fails with
// "Could not load the HTTP server (mik/server)". This launcher uses only the
// package's public entry points (`model-infra-kit` + `model-infra-kit/server`),
// so the dashboard can be developed and verified without touching the main
// package. Delete it once T07's CLI loader is fixed.
//
// Usage:
//   node apps/dashboard/scripts/serve-mik.mjs
//   node apps/dashboard/scripts/serve-mik.mjs --port 3211 --db ./.tmp/demo.db --app-id dashboard-demo
//   MIK_SERVER_TOKEN=secret node apps/dashboard/scripts/serve-mik.mjs --token secret
import { resolve } from "node:path"

function parseArgs(argv) {
  const values = { port: 3211, host: "127.0.0.1" }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--port") values.port = Number(argv[++index])
    else if (arg === "--host") values.host = argv[++index]
    else if (arg === "--db") values.db = argv[++index]
    else if (arg === "--app-id") values.appId = argv[++index]
    else if (arg === "--token") values.token = argv[++index]
    else if (arg === "--help" || arg === "-h") values.help = true
    else throw new Error(`unknown flag: ${arg}`)
  }
  return values
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log("用法: node scripts/serve-mik.mjs [--port 3211] [--host 127.0.0.1] [--db <path>] [--app-id <id>] [--token <t>]")
  process.exit(0)
}

let ModelInfra
let createServer
try {
  ;({ ModelInfra } = await import("model-infra-kit"))
  ;({ createServer } = await import("model-infra-kit/server"))
} catch (error) {
  console.error("无法加载 model-infra-kit（需要先构建）：")
  console.error("  pnpm --filter model-infra-kit build")
  console.error(String(error))
  process.exit(1)
}

const db = args.db ? resolve(args.db) : process.env.MIK_DB
const appId = args.appId ?? process.env.MIK_APP_ID ?? "default"
const token = args.token ?? process.env.MIK_SERVER_TOKEN

const hub = await ModelInfra.init({
  appId,
  db,
  onWarn: (message, error) => console.error(`warning: ${message}${error ? ` (${String(error)})` : ""}`),
})

const handle = await createServer({ hub, port: args.port, host: args.host, token })
console.log(`mik API  ${handle.url}   (appId=${appId}${db ? `, db=${db}` : ", db=default"})`)
console.log(`OpenAI 兼容入口  ${hub.baseUrl}`)
if (token) console.log("需要 Bearer token（值不显示）")
console.log("Ctrl+C 停止。")

let closing = false
const shutdown = async (signal) => {
  if (closing) return
  closing = true
  console.log(`\n收到 ${signal}，正在关闭…`)
  await handle.close()
  hub.close()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
