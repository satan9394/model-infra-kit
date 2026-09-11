import type { PricingOverride } from "../../store/pricing-repository.js"
import { flagNumber, flagString, type ParsedCli } from "../args.js"
import { requireArg, withContext, type RunOptions } from "../context.js"
import { CliRuntimeError, CliUsageError } from "../errors.js"
import { formatMoney, formatTable, formatTimestamp } from "../format.js"

function renderOverrides(overrides: readonly PricingOverride[]): string {
  if (overrides.length === 0) {
    return [
      "No manual price overrides.",
      "",
      "Set one with: mik pricing set <modelId> --input <usd/M> [--output <usd/M>]",
    ].join("\n")
  }
  const rows = overrides.map((override) => [
    override.modelId,
    override.displayName ?? override.modelId,
    formatMoney(override.inputPerM),
    formatMoney(override.outputPerM),
    formatMoney(override.cacheReadPerM),
    formatMoney(override.cacheWritePerM),
    formatTimestamp(override.updatedAt),
  ])
  return formatTable(
    ["MODEL", "NAME", "INPUT/M", "OUTPUT/M", "CACHE READ/M", "CACHE WRITE/M", "UPDATED"],
    rows,
    ["left", "left", "right", "right", "right", "right", "left"],
  )
}

function renderState(state: { status: string; source?: string; loadedAt?: number; lastError?: string }): string {
  return [
    `status  ${state.status}`,
    `source  ${state.source ?? "-"}`,
    `loaded  ${formatTimestamp(state.loadedAt)}`,
    `error   ${state.lastError ?? "-"}`,
  ].join("\n")
}

async function runList(parsed: ParsedCli, options: RunOptions): Promise<number> {
  return withContext(parsed, options, async (context) => {
    context.io.out("Catalogue")
    context.io.out(renderState(context.hub.pricing.state()))
    context.io.out("")
    context.io.out("Manual overrides")
    context.io.out(renderOverrides(context.hub.pricing.listOverrides()))
    return 0
  })
}

async function runSync(parsed: ParsedCli, options: RunOptions): Promise<number> {
  return withContext(parsed, options, async (context) => {
    if (context.offline) {
      throw new CliRuntimeError(`"mik pricing sync" needs network access; --offline is set.`)
    }
    const state = await context.hub.pricing.refresh()
    context.io.out(renderState(state))
    if (state.status === "error") {
      context.io.err("error: the price catalogue could not be refreshed; the bundled archive is still in use.")
      return 1
    }
    return 0
  })
}

function rate(parsed: ParsedCli, key: string): number | undefined {
  const value = flagNumber(parsed.values, key, parsed.action?.usage)
  if (value === undefined) return undefined
  if (value < 0) throw new CliUsageError(`--${key} must be zero or greater, got ${value}.`, parsed.action?.usage)
  return value
}

async function runSet(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const modelId = requireArg(parsed, 0, "<modelId>", options)
  const inputPerM = rate(parsed, "input")
  const outputPerM = rate(parsed, "output")
  const cacheReadPerM = rate(parsed, "cacheRead")
  const cacheWritePerM = rate(parsed, "cacheWrite")
  const displayName = flagString(parsed.values, "name")
  if (inputPerM === undefined && outputPerM === undefined) {
    throw new CliUsageError(
      "a manual price needs --input and/or --output; without one, every request would be recorded as $0.",
      parsed.action?.usage,
    )
  }

  return withContext(parsed, options, async (context) => {
    context.hub.pricing.setOverride({ modelId, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, displayName })
    context.io.out(`Manual price set for "${modelId}". It outranks every catalogue.`)
    context.io.out(renderOverrides(context.hub.pricing.listOverrides().filter((override) => override.modelId === modelId)))
    return 0
  })
}

export async function runPricing(parsed: ParsedCli, options: RunOptions): Promise<number> {
  switch (parsed.action?.name) {
    case "list":
      return runList(parsed, options)
    case "sync":
      return runSync(parsed, options)
    case "set":
      return runSet(parsed, options)
    default:
      throw new CliUsageError(`Unknown pricing action "${parsed.action?.name ?? ""}".`, parsed.command?.usage)
  }
}
