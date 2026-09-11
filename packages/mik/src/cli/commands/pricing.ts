import type { PricingOverride } from "../../store/pricing-repository.js"
import { flagNumber, flagString, type ParsedCli } from "../args.js"
import { contextLang, invocationLang, requireArg, withContext, type RunOptions } from "../context.js"
import { CliRuntimeError, CliUsageError } from "../errors.js"
import { formatMoney, formatTable, formatTimestamp } from "../format.js"
import { tr, type Lang } from "../i18n.js"

function renderOverrides(overrides: readonly PricingOverride[], lang: Lang): string {
  if (overrides.length === 0) {
    return [tr(lang, "pricing.overrides.empty"), "", tr(lang, "pricing.overrides.setWith")].join("\n")
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
    [
      tr(lang, "pricing.header.model"),
      tr(lang, "pricing.header.name"),
      tr(lang, "pricing.header.inputPerM"),
      tr(lang, "pricing.header.outputPerM"),
      tr(lang, "pricing.header.cacheReadPerM"),
      tr(lang, "pricing.header.cacheWritePerM"),
      tr(lang, "pricing.header.updated"),
    ],
    rows,
    ["left", "left", "right", "right", "right", "right", "left"],
  )
}

/**
 * The catalogue state block. Labels are localized; `status`/`source` *values*
 * (`fresh`/`stale`, `modelsdev`/`fallback`) stay literal because they are data,
 * not prose. The English labels keep their exact original spacing so the en
 * surface stays byte-identical.
 */
function renderState(
  state: { status: string; source?: string; loadedAt?: number; lastError?: string },
  lang: Lang,
): string {
  return [
    `${tr(lang, "pricing.state.status")}${state.status}`,
    `${tr(lang, "pricing.state.source")}${state.source ?? "-"}`,
    `${tr(lang, "pricing.state.loaded")}${formatTimestamp(state.loadedAt)}`,
    `${tr(lang, "pricing.state.error")}${state.lastError ?? "-"}`,
  ].join("\n")
}

async function runList(parsed: ParsedCli, options: RunOptions): Promise<number> {
  return withContext(parsed, options, async (context) => {
    const lang = contextLang(context, options)
    context.io.out(tr(lang, "pricing.catalog"))
    context.io.out(renderState(context.hub.pricing.state(), lang))
    context.io.out("")
    context.io.out(tr(lang, "pricing.overrides"))
    context.io.out(renderOverrides(context.hub.pricing.listOverrides(), lang))
    return 0
  })
}

async function runSync(parsed: ParsedCli, options: RunOptions): Promise<number> {
  return withContext(parsed, options, async (context) => {
    const lang = contextLang(context, options)
    if (context.offline) {
      throw new CliRuntimeError(tr(lang, "pricing.sync.offline"))
    }
    const state = await context.hub.pricing.refresh()
    context.io.out(renderState(state, lang))
    if (state.status === "error") {
      context.io.err(tr(lang, "pricing.sync.failed"))
      return 1
    }
    return 0
  })
}

function rate(parsed: ParsedCli, key: string, lang: Lang): number | undefined {
  const value = flagNumber(parsed.values, key, parsed.action?.usage, lang)
  if (value === undefined) return undefined
  if (value < 0) throw new CliUsageError(tr(lang, "pricing.error.negativeRate", key, value), parsed.action?.usage)
  return value
}

async function runSet(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const modelId = requireArg(parsed, 0, "<modelId>", options)
  // Flag validation runs before the hub opens, so it can only use the injected
  // invocation environment — never the real `process.env` (EVO-G12/G14).
  const flagLang = invocationLang(options)
  const inputPerM = rate(parsed, "input", flagLang)
  const outputPerM = rate(parsed, "output", flagLang)
  const cacheReadPerM = rate(parsed, "cacheRead", flagLang)
  const cacheWritePerM = rate(parsed, "cacheWrite", flagLang)
  const displayName = flagString(parsed.values, "name")
  if (inputPerM === undefined && outputPerM === undefined) {
    throw new CliUsageError(tr(flagLang, "pricing.error.needsRate"), parsed.action?.usage)
  }

  return withContext(parsed, options, async (context) => {
    const lang = contextLang(context, options)
    context.hub.pricing.setOverride({ modelId, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, displayName })
    context.io.out(tr(lang, "pricing.set.done", modelId))
    context.io.out(
      renderOverrides(
        context.hub.pricing.listOverrides().filter((override) => override.modelId === modelId),
        lang,
      ),
    )
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
      throw new CliUsageError(
        tr(invocationLang(options), "pricing.error.unknownAction", parsed.action?.name ?? ""),
        parsed.command?.usage,
      )
  }
}
