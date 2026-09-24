import type { ModelCapabilities, ModelInfo } from "../../types.js"
import { modelCatalog } from "../../catalog/index.js"
import { redact } from "../../util/redact.js"
import { flagBool, flagString, type ParsedCli } from "../args.js"
import { contextLang, invocationLang, messageOf, resolveIo, withContext, type RunOptions } from "../context.js"
import { CliRuntimeError } from "../errors.js"
import { formatMoney, formatTable, formatTokens } from "../format.js"
import { tr } from "../i18n.js"

const CATALOG_CAPABILITIES = [
  { key: "reasoning", label: "models.catalog.capability.reasoning" },
  { key: "vision", label: "models.catalog.capability.vision" },
  { key: "audio", label: "models.catalog.capability.audio" },
  { key: "tools", label: "models.catalog.capability.tools" },
  { key: "structuredOutputs", label: "models.catalog.capability.structuredOutputs" },
] as const
const CATALOG_STATUS_LABELS = {
  available: "models.catalog.status.available",
  deprecated: "models.catalog.status.deprecated",
  preview: "models.catalog.status.preview",
} as const

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

export function runModelCatalog(parsed: ParsedCli, options: RunOptions): number {
  const io = resolveIo(options)
  const lang = invocationLang(options)
  const models = modelCatalog.list()
  if (models.length === 0) {
    io.out(tr(lang, "models.catalog.empty"))
    return 0
  }

  const bindings = modelCatalog.listBindings()
  if (flagBool(parsed.values, "json")) {
    io.out(JSON.stringify({ source: "bundled static snapshot", models, bindings }, null, 2))
    return 0
  }

  const rows = models.map((model) => [
    model.id,
    model.name,
    model.family,
    formatTokens(model.contextWindow),
    model.maxOutputTokens === undefined ? "-" : formatTokens(model.maxOutputTokens),
    CATALOG_CAPABILITIES.filter(({ key }) => model.capabilities[key])
      .map(({ label }) => tr(lang, label))
      .join(",") || "-",
    bindings
      .filter((binding) => binding.modelId === model.id)
      .map(
        (binding) =>
          `${binding.providerId}/${binding.protocol}:${binding.upstreamModelName} (${tr(lang, CATALOG_STATUS_LABELS[binding.status])})`,
      )
      .join(",") || "-",
    model.sourceProviderId ? `${model.source} (${model.sourceProviderId})` : model.source,
  ])

  io.out(
    formatTable(
      [
        tr(lang, "models.catalog.header.id"),
        tr(lang, "models.catalog.header.name"),
        tr(lang, "models.catalog.header.family"),
        tr(lang, "models.catalog.header.context"),
        tr(lang, "models.catalog.header.maxOut"),
        tr(lang, "models.catalog.header.capabilities"),
        tr(lang, "models.catalog.header.providers"),
        tr(lang, "models.catalog.header.source"),
      ],
      rows,
      ["left", "left", "left", "right", "right", "left", "left", "left"],
    ),
  )
  io.out("")
  io.out(tr(lang, "models.catalog.summary", formatTokens(models.length)))
  return 0
}
