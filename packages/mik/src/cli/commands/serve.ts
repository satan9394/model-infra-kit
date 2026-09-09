import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ModelInfra } from "../../hub.js"
import { flagNumber, flagString, type ParsedCli } from "../args.js"
import { messageOf, resolveEnv, withContext, type RunOptions } from "../context.js"
import { CliRuntimeError } from "../errors.js"
import { assertPortFree } from "../ports.js"

export interface ServerHandle {
  url: string
  close: () => void | Promise<void>
}

export interface ServerOptions {
  hub: ModelInfra
  port?: number
  host?: string
  token?: string
}

export interface ServerModule {
  createServer: (options: ServerOptions) => ServerHandle | Promise<ServerHandle>
}

/**
 * Candidate specifiers for the sibling server bundle, in resolution order.
 *
 * The CLI runs from two layouts: `src/cli/commands/serve.ts` while developing
 * and `dist/cli.mjs` once built, where tsdown emits `dist/server.mjs` right
 * beside it. Every candidate is resolved against the module that is running, so
 * a built or installed CLI finds its own bundle instead of walking up into the
 * host project's tree.
 */
const SERVER_CANDIDATES = [
  "./server.mjs", // built:  dist/cli.mjs         → dist/server.mjs
  "../server.mjs", // built:  dist/cli/cli.mjs     → dist/cli/server.mjs (nested layout)
  "../../server/index.js", // source: src/cli/commands/ → src/server/index.js (compiled in place)
  "../../server/index.ts", // source: src/cli/commands/ → src/server/index.ts (ts loader / vitest)
  "../server/index.ts", // source: src/cli/          → src/server/index.ts
]

/** Candidate server-bundle URLs for a given running module (`from`). */
export function serverModuleCandidates(from: string | URL = import.meta.url): URL[] {
  const base = typeof from === "string" ? from : from.href
  return SERVER_CANDIDATES.map((specifier) => new URL(specifier, base))
}

/** The first candidate that exists on disk; throws when no known layout matches. */
export function resolveServerModuleUrl(from: string | URL = import.meta.url): URL {
  const candidates = serverModuleCandidates(from)
  for (const candidate of candidates) {
    if (existsSync(fileURLToPath(candidate))) return candidate
  }
  throw new CliRuntimeError(
    `Could not find the HTTP server bundle (mik/server).\n` +
      `  Tried:\n${candidates.map((candidate) => `    ${candidate.href}`).join("\n")}\n` +
      `  Build the package first: pnpm --filter model-infra-kit build`,
  )
}

/**
 * Load the HTTP server lazily and by URL, never by a static import.
 *
 * The server is a sibling bundle (`src/server` while developing, `dist/server.mjs`
 * once built), so both layouts are tried. Loading it on demand also keeps every
 * other subcommand independent of the server's own dependencies.
 */
export async function loadServerModule(from: string | URL = import.meta.url): Promise<ServerModule> {
  const url = resolveServerModuleUrl(from)
  try {
    const loaded = (await import(url.href)) as { createServer?: unknown }
    if (typeof loaded.createServer !== "function") {
      throw new CliRuntimeError(`${url.href} does not export createServer().`)
    }
    return loaded as unknown as ServerModule
  } catch (error) {
    if (error instanceof CliRuntimeError) throw error
    throw new CliRuntimeError(
      `Could not load the HTTP server (mik/server) from ${url.href}. ${messageOf(error)}\n` +
        `  Build the package first: pnpm --filter model-infra-kit build`,
    )
  }
}

/** Resolve on SIGINT/SIGTERM after the handle has been closed. */
function waitForShutdown(stop: () => void | Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    }
    const onSignal = (): void => {
      void Promise.resolve()
        .then(stop)
        .then(
          () => {
            finish()
            resolve()
          },
          (error: unknown) => {
            finish()
            reject(error)
          },
        )
    }
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
  })
}

export async function runServe(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const port = flagNumber(parsed.values, "port", parsed.action?.usage ?? parsed.command?.usage) ?? 3211
  const host = flagString(parsed.values, "host") ?? "127.0.0.1"
  const env = resolveEnv(options)
  // A token on the command line is visible to other processes; the environment
  // variable is offered as the quieter alternative and never printed.
  const token = flagString(parsed.values, "token") ?? (env.MIK_SERVER_TOKEN || undefined)

  // Checked before the database is even opened, so a taken port fails fast.
  await assertPortFree(port, "serve")

  return withContext(parsed, options, async (context) => {
    const module = await loadServerModule()
    const handle = await module.createServer({ hub: context.hub, port, host, token })
    context.io.out(`Listening on ${handle.url}`)
    context.io.out(`OpenAI-compatible base URL: ${context.hub.baseUrl}`)
    if (token) context.io.out("Bearer token required (value not shown).")
    context.io.out("Press Ctrl+C to stop.")
    await waitForShutdown(() => handle.close())
    context.io.out("Stopped.")
    return 0
  })
}
