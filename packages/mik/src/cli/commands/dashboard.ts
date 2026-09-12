import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { flagNumber, flagString, type ParsedCli } from "../args.js"
import { superviseChild } from "../child-supervision.js"
import { resolveCwd, resolveEnv, resolveIo, invocationLang, messageOf, type RunOptions } from "../context.js"
import { CliRuntimeError } from "../errors.js"
import { assertPortFree } from "../ports.js"
import { tr, type Lang } from "../i18n.js"

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

/**
 * The packaging hint in the invocation language (EVO-G69 / G68).
 *
 * `DASHBOARD_PACKAGING_HINT` stays the English source of truth: the `en` entry of
 * `dashboard.hint.packaging` is byte-identical to it, and the fallback below keeps
 * the English output byte-identical even if the key were ever missing. The paths,
 * commands and placeholders inside the hint are data and stay verbatim.
 */
export function dashboardPackagingHint(lang: Lang = "en"): string {
  const translated = tr(lang, "dashboard.hint.packaging")
  return translated === "" ? DASHBOARD_PACKAGING_HINT : translated
}

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

/**
 * The error thrown when no dashboard directory can be resolved.
 *
 * `lang` defaults to `en` so the signature stays source-compatible for embedders;
 * every CLI call site passes the invocation language it already resolved.
 */
export function missingDashboardError(lang: Lang = "en"): CliRuntimeError {
  return new CliRuntimeError(
    tr(lang, "dashboard.error.missingApp", DASHBOARD_DISPLAY_DIR, dashboardPackagingHint(lang)),
  )
}

/**
 * The error thrown when the dashboard child process cannot be spawned.
 *
 * Split out of the `child.once("error")` handler because that handler can only
 * run on a real spawn failure, which the launcher cannot produce on demand (it
 * always spawns `process.execPath` with an absolute script path). Exported so the
 * localized wording is testable; the handler itself is wired to it.
 */
export function dashboardSpawnError(error: unknown, lang: Lang = "en"): CliRuntimeError {
  return new CliRuntimeError(tr(lang, "dashboard.error.spawnFailed", messageOf(error)))
}

/**
 * pnpm's real entry point sits next to its shim: `<dir>/pnpm.cmd` is a two-line
 * wrapper that runs `<dir>/node_modules/pnpm/bin/pnpm.mjs` with node.
 */
const PNPM_SCRIPT_RELATIVE = join("node_modules", "pnpm", "bin", "pnpm.mjs")

/** Shim names to look for on PATH. Windows installs `pnpm.cmd`; POSIX a plain `pnpm`. */
const PNPM_SHIM_NAMES = process.platform === "win32" ? ["pnpm.cmd", "pnpm.exe", "pnpm"] : ["pnpm"]

/** PATH lookup tolerating the several spellings Windows uses for that variable. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? env.path ?? "").split(delimiter).filter((entry) => entry.length > 0)
}

/**
 * Resolve the JavaScript entry point of pnpm, or `null` when pnpm is not installed.
 *
 * Spawning `pnpm.cmd` directly is *not* an option: since the fix for CVE-2024-27980
 * Node refuses to launch `.cmd`/`.bat` shims unless the shell option is enabled,
 * and throws EINVAL (verified on Node 24.14). A shell is precisely what this path
 * avoids, so we run the same script the shim would run — `node <pnpm.mjs> …` — and
 * keep the spawn shell-free. Returning `null` lets the caller print the packaging
 * guidance instead of an opaque ENOENT.
 */
export function findPnpmScript(env: NodeJS.ProcessEnv = process.env): string | null {
  // Set whenever `mik` itself was launched through pnpm (`pnpm exec mik …`), which
  // is the common case inside this monorepo.
  const execPath = env.npm_execpath
  if (execPath && /\.(?:mjs|cjs|js)$/i.test(execPath) && existsSync(execPath)) return execPath

  for (const entry of pathEntries(env)) {
    for (const shim of PNPM_SHIM_NAMES) {
      if (!existsSync(join(entry, shim))) continue
      const script = join(entry, PNPM_SCRIPT_RELATIVE)
      if (existsSync(script)) return script
    }
  }
  return null
}

export async function runDashboard(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const lang = invocationLang(options)
  const port = flagNumber(parsed.values, "port", parsed.command?.usage, lang) ?? 3210
  const env = resolveEnv(options)
  const cwd = resolveCwd(options)
  // `main()` dispatches with the raw options, so resolve the streams here — otherwise
  // the "Starting dashboard from …" line is silently dropped in real CLI runs.
  const io = resolveIo(options)

  await assertPortFree(port, "dashboard", lang)

  const dir = flagString(parsed.values, "dir") ?? env.MIK_DASHBOARD_DIR ?? findDashboardDir(cwd)
  if (!dir) {
    throw missingDashboardError(lang)
  }
  if (!existsSync(join(dir, "package.json"))) {
    throw new CliRuntimeError(tr(lang, "dashboard.error.notAPackage", dir, dashboardPackagingHint(lang)))
  }

  const nextBin = join(dir, "node_modules", "next", "dist", "bin", "next")
  const useLocalNext = existsSync(nextBin)
  // Both branches spawn node directly: no `shell` option anywhere, so no part of
  // this command line is ever parsed by a shell (EVO-G09 / audit-reliability P2-2).
  let command = process.execPath
  let args: string[]
  if (useLocalNext) {
    args = [nextBin, "start", "-p", String(port)]
  } else {
    // `env` (not the real `process.env`) so an injected environment decides where
    // pnpm is looked up, exactly like every other probe in this command (EVO-G12/G69).
    const pnpmScript = findPnpmScript(env)
    if (!pnpmScript) {
      throw new CliRuntimeError(
        tr(lang, "dashboard.error.noEntryPoint", dir, dashboardPackagingHint(lang)),
      )
    }
    args = [pnpmScript, "exec", "next", "start", "-p", String(port)]
  }

  io.out(tr(lang, "dashboard.starting", dir, String(port)))
  const child = spawn(command, args, {
    cwd: dir,
    stdio: "inherit",
    env: { ...env, PORT: String(port) },
  })

  // Hand the child's lifetime to the supervisor: Ctrl+C — or the parent dying
  // without cleanup — must not leave `next` running and holding the port.
  // Windows needs the process tree (`pnpm → next`), hence the supervisor.
  const dispose = superviseChild(child)

  return new Promise<number>((resolve, reject) => {
    child.once("error", (error) => {
      dispose()
      reject(dashboardSpawnError(error, lang))
    })
    child.once("exit", (code) => {
      // The child is gone: stop supervising so the parent's `exit` hook does not
      // signal a stale pid, and so no escalation timer survives the run.
      dispose()
      resolve(code ?? 0)
    })
  })
}
