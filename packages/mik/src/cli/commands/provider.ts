import { defaultSecretPath } from "../../credential/store.js"
import { PROTOCOL_PACKAGES, getPreset } from "../../registry/index.js"
import type { Protocol, ProviderRecord } from "../../types.js"
import { redact } from "../../util/redact.js"
import { flagBool, flagString, type ParsedCli } from "../args.js"
import { contextLang, invocationLang, requireArg, withContext, type RunOptions } from "../context.js"
import { CliRuntimeError, CliUsageError } from "../errors.js"
import { formatTable, formatTimestamp } from "../format.js"
import { tr, type Lang } from "../i18n.js"
import { missingPackageForProtocol } from "../packages.js"
import { isAffirmative, isInteractive, prompt } from "../prompt.js"

const REF_PATTERN = /^(env|file|keychain):.+/i

/** What `provider list` shows for a provider's key: the reference, never a secret. */
function keyRefLabel(record: ProviderRecord): string {
  if (record.apiKeyRef) return redact(record.apiKeyRef)
  const preset = record.presetId ? getPreset(record.presetId) : undefined
  return preset?.envKey ? `env:${preset.envKey}` : "-"
}

/** The `provider list`/`provider add` column headers, localized (EVO-G13). */
function providerHeaders(lang: Lang, includeDefault: boolean): string[] {
  const headers = [
    tr(lang, "provider.header.provider"),
    tr(lang, "provider.header.name"),
    tr(lang, "provider.header.protocol"),
    tr(lang, "provider.header.baseUrl"),
    tr(lang, "provider.header.keyRef"),
    tr(lang, "provider.header.enabled"),
  ]
  if (includeDefault) headers.push(tr(lang, "provider.header.default"))
  return headers
}

export function renderProviderTable(records: readonly ProviderRecord[], defaultRef: string | null, lang: Lang): string {
  if (records.length === 0) {
    return [
      tr(lang, "provider.list.empty"),
      "",
      tr(lang, "provider.list.emptyHint"),
      // The two example commands stay literal: they are copy-pasteable argv.
      "  mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY",
      `  mik provider list`,
    ].join("\n")
  }
  const defaultProvider = defaultRef?.includes(":") ? defaultRef.slice(0, defaultRef.indexOf(":")) : null
  // `yes`/`no` are recorded *values*, not prose: they stay literal in both
  // languages so the column never stops being machine-readable.
  const rows = records.map((record) => [
    record.id,
    record.name ?? record.id,
    record.protocol ?? "-",
    record.baseUrl ?? "-",
    keyRefLabel(record),
    record.enabled ? "yes" : "no",
    record.id === defaultProvider ? "yes" : "",
  ])
  return formatTable(providerHeaders(lang, true), rows)
}

async function runList(parsed: ParsedCli, options: RunOptions): Promise<number> {
  return withContext(parsed, options, async (context) => {
    const lang = contextLang(context, options)
    const records = context.hub.providers.list()
    context.io.out(renderProviderTable(records, context.hub.providers.defaultModel(), lang))
    if (records.length > 0) {
      const defaultRef = context.hub.providers.defaultModel()
      context.io.out("")
      context.io.out(tr(lang, "provider.list.defaultModel", defaultRef ?? tr(lang, "provider.list.notSet")))
      context.io.out(tr(lang, "provider.list.database", context.dbPath))
    }
    return 0
  })
}

export function validateApiKeyRef(id: string, ref: string, lang: Lang): void {
  if (REF_PATTERN.test(ref)) return
  throw new CliUsageError(
    tr(lang, "provider.error.badKeyRef", defaultSecretPath(id).replace(/^file:/, ""), defaultSecretPath(id)),
  )
}

/** `--protocol` must name a protocol the bridge can actually build. */
export function parseProtocol(value: string | undefined, usage: string | undefined, lang: Lang): Protocol | undefined {
  if (value === undefined) return undefined
  if (!Object.prototype.hasOwnProperty.call(PROTOCOL_PACKAGES, value)) {
    throw new CliUsageError(
      tr(lang, "provider.error.unknownProtocol", value, Object.keys(PROTOCOL_PACKAGES).join(", ")),
      usage,
    )
  }
  return value as Protocol
}

/** The explicit notice the card requires when no credential reference is given. */
export function apiKeyNotice(id: string, presetId: string | undefined, lang: Lang): string {
  const preset = presetId ? getPreset(presetId) : undefined
  const lines: string[] = []
  if (preset?.envKey) {
    lines.push(tr(lang, "provider.add.noKeyRefNote", id, preset.envKey))
  } else {
    const scope = preset ? tr(lang, "provider.add.presetLabel", preset.id) : tr(lang, "provider.add.noPreset")
    lines.push(tr(lang, "provider.add.noKeyRefWarn", scope))
  }
  lines.push(tr(lang, "provider.add.hintCommand", id, defaultSecretPath(id)))
  lines.push(tr(lang, "provider.add.hintWriteSecret"))
  return lines.join("\n")
}

async function runAdd(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const id = requireArg(parsed, 0, "<id>", options)
  const presetId = flagString(parsed.values, "preset")
  const baseUrl = flagString(parsed.values, "baseUrl")
  const name = flagString(parsed.values, "name")
  // Flag validation runs before the hub opens, so it can only use the injected
  // invocation environment (`invocationLang(options)`) — never the real one.
  const flagLang = invocationLang(options)
  const protocol = parseProtocol(flagString(parsed.values, "protocol"), parsed.action?.usage, flagLang)
  const apiKeyRef = flagString(parsed.values, "apiKeyRef")
  if (apiKeyRef) validateApiKeyRef(id, apiKeyRef, flagLang)

  return withContext(parsed, options, async (context) => {
    const { io } = context
    const lang = contextLang(context, options)
    if (!apiKeyRef) io.out(apiKeyNotice(id, presetId, lang))
    const record = context.hub.providers.add({ id, presetId, baseUrl, name, protocol, apiKeyRef })
    io.out("")
    io.out(tr(lang, "provider.add.added", record.id))
    io.out(
      formatTable(
        providerHeaders(lang, false),
        [[record.id, record.name, record.protocol ?? "-", record.baseUrl ?? "-", keyRefLabel(record), record.enabled ? "yes" : "no"]],
      ),
    )
    io.out(tr(lang, "provider.add.updated", formatTimestamp(record.updatedAt)))
    if (!apiKeyRef) {
      io.out("")
      io.out(tr(lang, "provider.add.verifyWith", record.id))
    }
    // EVO-G15 (G54): the `@ai-sdk/*` implementation is an optional peer, so a
    // provider can be configured successfully and still 502 on its first call.
    // Say so here, with the copy-pasteable install command, instead of letting
    // the user discover it from a failed request. Silent when the package resolves.
    const missingPackage = missingPackageForProtocol(record.protocol)
    if (missingPackage) {
      io.out("")
      io.out(tr(lang, "provider.add.missingPackage", missingPackage, missingPackage))
    }
    return 0
  })
}

async function runRemove(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const id = requireArg(parsed, 0, "<id>", options)
  return withContext(parsed, options, async (context) => {
    const { io } = context
    const lang = contextLang(context, options)
    const existing = context.hub.providers.get(id)
    if (!existing) throw new CliRuntimeError(tr(lang, "provider.error.notConfigured", id))

    if (!flagBool(parsed.values, "yes")) {
      if (!isInteractive(options)) {
        throw new CliUsageError(tr(lang, "provider.error.refuseRemove", id, id))
      }
      const answer = await prompt(tr(lang, "provider.remove.prompt", id))
      if (!isAffirmative(answer)) {
        io.out(tr(lang, "provider.remove.aborted"))
        return 0
      }
    }

    const removed = context.hub.providers.remove(id)
    io.out(removed ? tr(lang, "provider.remove.removed", id) : tr(lang, "provider.remove.alreadyGone", id))
    io.out(tr(lang, "provider.remove.usageKept"))
    return 0
  })
}

/**
 * EVO-G70 (G60) — a localized one-line failure label for `provider test`.
 *
 * The table's `message` column used to repeat the library's full English
 * sentence, so a credential failure shown next to `warning: …` read as the same
 * English text twice. The label classifies the *shape* of the failure and keeps
 * the data verbatim: the environment variable name stays as written, and so does
 * anything the classifier cannot name (falling back to the original message).
 *
 * Only `zh` gets the short label; `en` keeps the existing sentence, so the
 * English surface stays byte-identical (card §A4).
 */
export function providerTestMessage(message: string, lang: Lang): string {
  if (lang === "en") return message
  const credential = /Environment variable\s+(\S+)\s+is not set for this provider's API key/.exec(message)
  if (credential) return tr(lang, "provider.test.failure.credential", credential[1])
  const missingPackage = /provider package\s+(\S+)\s+is not installed/.exec(message)
  if (missingPackage) return tr(lang, "provider.test.failure.missingPackage", missingPackage[1], missingPackage[1])
  if (/API key rejected by the provider/.test(message)) return tr(lang, "provider.test.failure.auth")
  if (
    /Could not reach the provider endpoint/.test(message) ||
    /did not respond in time/.test(message) ||
    /server error/i.test(message) ||
    /rate limiting/i.test(message)
  ) {
    return tr(lang, "provider.test.failure.connection")
  }
  if (/does not recognise this model id|model.*not found/i.test(message)) return tr(lang, "provider.test.failure.model")
  return message
}

async function runTest(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const id = requireArg(parsed, 0, "<id>", options)
  return withContext(parsed, options, async (context) => {
    const { io } = context
    const lang = contextLang(context, options)
    if (context.offline) {
      throw new CliRuntimeError(tr(lang, "provider.test.offline"))
    }
    const status = await context.hub.ai.test(id)
    io.out(
      formatTable(
        [
          tr(lang, "provider.test.header.provider"),
          tr(lang, "provider.test.header.result"),
          tr(lang, "provider.test.header.latency"),
          tr(lang, "provider.test.header.models"),
          tr(lang, "provider.test.header.message"),
        ],
        [
          [
            status.providerId,
            // `ok`/`failed` are status values consumed by scripts; the message is
            // the provider's own (redacted) text, localized into a short label
            // where the failure shape is recognisable (EVO-G70/G60).
            status.ok ? "ok" : "failed",
            status.latencyMs === undefined ? "-" : `${status.latencyMs} ms`,
            status.modelCount === undefined ? "-" : String(status.modelCount),
            redact(providerTestMessage(status.message, lang)),
          ],
        ],
      ),
    )
    return status.ok ? 0 : 1
  })
}

export async function runProvider(parsed: ParsedCli, options: RunOptions): Promise<number> {
  switch (parsed.action?.name) {
    case "list":
      return runList(parsed, options)
    case "add":
      return runAdd(parsed, options)
    case "remove":
      return runRemove(parsed, options)
    case "test":
      return runTest(parsed, options)
    default:
      throw new CliUsageError(
        tr(invocationLang(options), "provider.error.unknownAction", parsed.action?.name ?? ""),
        parsed.command?.usage,
      )
  }
}
