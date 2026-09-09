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
 * Load the HTTP server lazily and by URL, never by a static import.
 *
 * The server is a sibling bundle (`src/server` while developing, `dist/server.mjs`
 * once built), so both layouts are tried. Loading it on demand also keeps every
 * other subcommand independent of the server's own dependencies.
 */
export async function loadServerModule(): Promise<ServerModule> {
  const candidates = ["../../server/index.js", "../server.mjs", "../../server/index.ts"]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, import.meta.url).href
      const loaded = (await import(url)) as { createServer?: unknown }
      if (typeof loaded.createServer === "function") return loaded as unknown as ServerModule
      lastError = new CliRuntimeError(`${candidate} does not export createServer().`)
    } catch (error) {
      lastError = error
    }
  }
  throw new CliRuntimeError(
    `Could not load the HTTP server (mik/server). ${lastError ? messageOf(lastError) : ""}\n` +
      `  Build the package first: pnpm --filter model-infra-kit build`,
  )
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
