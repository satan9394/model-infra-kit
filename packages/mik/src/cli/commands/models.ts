import type { ModelCapabilities, ModelInfo } from "../../types.js"
import { redact } from "../../util/redact.js"
import { flagBool, flagString, type ParsedCli } from "../args.js"
import { messageOf, withContext, type RunOptions } from "../context.js"
import { CliRuntimeError } from "../errors.js"
import { formatMoney, formatTable, formatTokens } from "../format.js"

export function describeCapabilities(capabilities: ModelCapabilities): string {
  const tags: string[] = []
  if (capabilities.text) tags.push("text")
  if (capabilities.toolCall) tags.push("tools")
  if (capabilities.reasoning) tags.push("reasoning")
  if (capabilities.image) tags.push("image")
  if (capabilities.structuredOutput) tags.push("json")
  return tags.length > 0 ? tags.join(",") : "-"
}

export async function runModels(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const providerId = flagString(parsed.values, "provider")
  const refresh = flagBool(parsed.values, "refresh")

  return withContext(parsed, options, async (context) => {
    const { io, hub } = context

    if (refresh) {
      if (context.offline) {
        throw new CliRuntimeError(`"mik models --refresh" needs network access; --offline is set.`)
      }
      const targets = providerId ? [providerId] : hub.providers.list().map((provider) => provider.id)
      if (targets.length === 0) {
        io.out("No providers configured; nothing to refresh.")
        io.out("Add one with: mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY")
        return 0
      }
      for (const id of targets) {
        try {
          const models = await hub.models.refresh(id)
          io.out(`Refreshed ${id}: ${formatTokens(models.length)} models`)
        } catch (error) {
          io.err(`warning: could not refresh "${id}": ${redact(messageOf(error))}`)
        }
      }
      io.out("")
    }

    const models = hub.models.list(providerId)
    if (models.length === 0) {
      io.out(
        providerId
          ? `No models stored for provider "${providerId}".`
          : "No models stored yet.",
      )
      io.out("Discover them with: mik models --refresh  (needs a provider with a working credential)")
      return 0
    }

    const rows = models.map((model: ModelInfo) => {
      const card = hub.pricing.priceFor(model.modelId)
      return [
        model.providerId,
        model.ref,
        model.contextWindow === undefined ? "-" : formatTokens(model.contextWindow),
        model.maxOutputTokens === undefined ? "-" : formatTokens(model.maxOutputTokens),
        formatMoney(card?.inputPerM),
        formatMoney(card?.outputPerM),
        model.source,
        describeCapabilities(model.capabilities),
      ]
    })

    io.out(
      formatTable(
        ["PROVIDER", "MODEL", "CONTEXT", "MAX OUT", "IN/M", "OUT/M", "SOURCE", "CAPS"],
        rows,
        ["left", "left", "right", "right", "right", "right", "left", "left"],
      ),
    )
    io.out("")
    io.out(`${formatTokens(models.length)} model(s). Prices are USD per million tokens (4 decimals).`)
    return 0
  })
}
