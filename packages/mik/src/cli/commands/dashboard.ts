import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { flagNumber, flagString, type ParsedCli } from "../args.js"
import { resolveCwd, resolveEnv, type RunOptions } from "../context.js"
import { CliRuntimeError } from "../errors.js"
import { assertPortFree } from "../ports.js"

/** Walk up from `start` looking for `<relative>`; returns the first hit. */
export function walkUpFor(start: string, relative: string, depth = 8): string | null {
  let directory = start
  for (let level = 0; level < depth; level += 1) {
    const candidate = join(directory, relative)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/** The dashboard app lives at `apps/dashboard` in this monorepo. */
export function findDashboardDir(cwd: string): string | null {
  const fromCwd = walkUpFor(cwd, join("apps", "dashboard"))
  if (fromCwd) return fromCwd
  const here = dirname(fileURLToPath(import.meta.url))
  return walkUpFor(here, join("apps", "dashboard"))
}

export async function runDashboard(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const port = flagNumber(parsed.values, "port", parsed.command?.usage) ?? 3210
  const env = resolveEnv(options)
  const cwd = resolveCwd(options)
  const io = options.io

  await assertPortFree(port, "dashboard")

  const dir = flagString(parsed.values, "dir") ?? env.MIK_DASHBOARD_DIR ?? findDashboardDir(cwd)
  if (!dir) {
    throw new CliRuntimeError(
      "Could not find the dashboard app (apps/dashboard).\n" +
        "  Build it first: pnpm --filter @mik/dashboard build\n" +
        "  or point at it: mik dashboard --dir <path>",
    )
  }
  if (!existsSync(join(dir, "package.json"))) {
    throw new CliRuntimeError(`${dir} does not look like a package (no package.json).`)
  }

  const nextBin = join(dir, "node_modules", "next", "dist", "bin", "next")
  const useLocalNext = existsSync(nextBin)
  const command = useLocalNext ? process.execPath : "pnpm"
  const args = useLocalNext ? [nextBin, "start", "-p", String(port)] : ["exec", "next", "start", "-p", String(port)]

  io?.out?.(`Starting dashboard from ${dir} on http://127.0.0.1:${port}`)
  const child = spawn(command, args, {
    cwd: dir,
    stdio: "inherit",
    shell: !useLocalNext && process.platform === "win32",
    env: { ...env, PORT: String(port) },
  })

  return new Promise<number>((resolve, reject) => {
    child.once("error", (error) => reject(new CliRuntimeError(`Could not start the dashboard: ${error.message}`)))
    child.once("exit", (code) => resolve(code ?? 0))
  })
}
