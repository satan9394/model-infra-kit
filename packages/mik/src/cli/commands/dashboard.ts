import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { flagNumber, flagString, type ParsedCli } from "../args.js"
import { superviseChild } from "../child-supervision.js"
import { resolveCwd, resolveEnv, resolveIo, type RunOptions } from "../context.js"
import { CliRuntimeError } from "../errors.js"
import { assertPortFree } from "../ports.js"

/** Where the dashboard app lives inside this monorepo. */
export const DASHBOARD_RELATIVE_DIR = join("apps", "dashboard")

/** Forward-slash form for messages and docs, so they read the same on Windows. */
const DASHBOARD_DISPLAY_DIR = "apps/dashboard"

/**
 * Printed whenever the dashboard app cannot be found or started. The dashboard
 * is deliberately not part of the published tarball (`files: ["dist", "LICENSE"]`),
 * so a consumer who installed `model-infra-kit` from npm can never reach it.
 */
export const DASHBOARD_PACKAGING_HINT =
  "The dashboard is not published with the npm package: model-infra-kit ships the library, the CLI and the HTTP server only.\n" +
  "  Installed from npm? Run the dashboard from a clone of the repository, or deploy apps/dashboard yourself.\n" +
  "  In the monorepo: pnpm --filter @mik/dashboard dev   (or build + start)\n" +
  "  Or point the CLI at an existing copy: mik dashboard --dir <path>\n" +
  "  See the \"Dashboard\" section of the project README."

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

/**
 * The dashboard app lives at `apps/dashboard` in this monorepo. Look next to the
 * caller first, then next to this module — the latter is what makes `mik
 * dashboard` work from anywhere inside the repository, and what makes it fail
 * (with guidance) for anyone who installed the package from npm.
 */
export function findDashboardDir(
  cwd: string,
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
  return walkUpFor(cwd, DASHBOARD_RELATIVE_DIR) ?? walkUpFor(moduleDir, DASHBOARD_RELATIVE_DIR)
}

/** The error thrown when no dashboard directory can be resolved. */
export function missingDashboardError(): CliRuntimeError {
  return new CliRuntimeError(
    `Could not find the dashboard app (${DASHBOARD_DISPLAY_DIR}).\n${DASHBOARD_PACKAGING_HINT}`,
  )
}

export async function runDashboard(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const port = flagNumber(parsed.values, "port", parsed.command?.usage) ?? 3210
  const env = resolveEnv(options)
  const cwd = resolveCwd(options)
  // `main()` dispatches with the raw options, so resolve the streams here — otherwise
  // the "Starting dashboard from …" line is silently dropped in real CLI runs.
  const io = resolveIo(options)

  await assertPortFree(port, "dashboard")

  const dir = flagString(parsed.values, "dir") ?? env.MIK_DASHBOARD_DIR ?? findDashboardDir(cwd)
  if (!dir) {
    throw missingDashboardError()
  }
  if (!existsSync(join(dir, "package.json"))) {
    throw new CliRuntimeError(`${dir} does not look like a package (no package.json).\n${DASHBOARD_PACKAGING_HINT}`)
  }

  const nextBin = join(dir, "node_modules", "next", "dist", "bin", "next")
  const useLocalNext = existsSync(nextBin)
  const command = useLocalNext ? process.execPath : "pnpm"
  const args = useLocalNext ? [nextBin, "start", "-p", String(port)] : ["exec", "next", "start", "-p", String(port)]

  io.out(`Starting dashboard from ${dir} on http://127.0.0.1:${port}`)
  const child = spawn(command, args, {
    cwd: dir,
    stdio: "inherit",
    shell: !useLocalNext && process.platform === "win32",
    env: { ...env, PORT: String(port) },
  })

  // Hand the child's lifetime to the supervisor: Ctrl+C — or the parent dying
  // without cleanup — must not leave `next` running and holding the port.
  // Windows needs the process tree (`pnpm → next`), hence the supervisor.
  const dispose = superviseChild(child)

  return new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      dispose()
      reject(new CliRuntimeError(`Could not start the dashboard: ${error.message}`))
    })
    child.once("exit", (code) => {
      // The child is gone: stop supervising so the parent's `exit` hook does not
      // signal a stale pid, and so no escalation timer survives the run.
      dispose()
      resolve(code ?? 0)
    })
  })
}
