import type { ModelCapabilities, ModelInfo } from "../../types.js"
import { redact } from "../../util/redact.js"
import { flagBool, flagString, type ParsedCli } from "../args.js"
import { contextLang, messageOf, withContext, type RunOptions } from "../context.js"
import { CliRuntimeError } from "../errors.js"
import { formatMoney, formatTable, formatTokens } from "../format.js"
import { tr } from "../i18n.js"

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
    // The language of the *command body*: the injected env plus a stored
    // `cli.lang` set by `/lang` in the REPL. Never the real `process.env`.
    const lang = contextLang(context, options)

    if (refresh) {
      if (context.offline) {
        throw new CliRuntimeError(tr(lang, "models.refresh.offline"))
      }
      const targets = providerId ? [providerId] : hub.providers.list().map((provider) => provider.id)
      if (targets.length === 0) {
        io.out(tr(lang, "models.refresh.noProviders"))
        io.out(tr(lang, "models.refresh.addOne"))
        return 0
      }
      for (const id of targets) {
        try {
          const models = await hub.models.refresh(id)
          io.out(tr(lang, "models.refresh.ok", id, formatTokens(models.length)))
        } catch (error) {
          io.err(tr(lang, "models.refresh.failed", id, redact(messageOf(error))))
        }
      }
      io.out("")
    }

    const models = hub.models.list(providerId)
    if (models.length === 0) {
      io.out(providerId ? tr(lang, "models.empty.provider", providerId) : tr(lang, "models.empty.none"))
      io.out(tr(lang, "models.empty.discover"))
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
        [
          tr(lang, "models.header.provider"),
          tr(lang, "models.header.model"),
          tr(lang, "models.header.context"),
          tr(lang, "models.header.maxOut"),
          tr(lang, "models.header.inputPerM"),
          tr(lang, "models.header.outputPerM"),
          tr(lang, "models.header.source"),
          tr(lang, "models.header.caps"),
        ],
        rows,
        ["left", "left", "right", "right", "right", "right", "left", "left"],
      ),
    )
    io.out("")
    io.out(tr(lang, "models.summary", formatTokens(models.length)))
    return 0
  })
}
