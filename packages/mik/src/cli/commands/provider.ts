import { defaultSecretPath } from "../../credential/store.js"
import { PROTOCOL_PACKAGES, getPreset } from "../../registry/index.js"
import type { Protocol, ProviderRecord } from "../../types.js"
import { redact } from "../../util/redact.js"
import { flagBool, flagString, type ParsedCli } from "../args.js"
import { requireArg, withContext, type RunOptions } from "../context.js"
import { CliRuntimeError, CliUsageError } from "../errors.js"
import { formatTable, formatTimestamp } from "../format.js"
import { isAffirmative, isInteractive, prompt } from "../prompt.js"

const REF_PATTERN = /^(env|file|keychain):.+/i

/** What `provider list` shows for a provider's key: the reference, never a secret. */
function keyRefLabel(record: ProviderRecord): string {
  if (record.apiKeyRef) return redact(record.apiKeyRef)
  const preset = record.presetId ? getPreset(record.presetId) : undefined
  return preset?.envKey ? `env:${preset.envKey}` : "-"
}

export function renderProviderTable(records: readonly ProviderRecord[], defaultRef: string | null): string {
  if (records.length === 0) {
    return [
      "No providers configured.",
      "",
      "Add one with:",
      "  mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY",
      `  mik provider list`,
    ].join("\n")
  }
  const defaultProvider = defaultRef?.includes(":") ? defaultRef.slice(0, defaultRef.indexOf(":")) : null
  const rows = records.map((record) => [
    record.id,
    record.name ?? record.id,
    record.protocol ?? "-",
    record.baseUrl ?? "-",
    keyRefLabel(record),
    record.enabled ? "yes" : "no",
    record.id === defaultProvider ? "yes" : "",
  ])
  return formatTable(["PROVIDER", "NAME", "PROTOCOL", "BASE URL", "KEY REF", "ENABLED", "DEFAULT"], rows)
}

async function runList(parsed: ParsedCli, options: RunOptions): Promise<number> {
  return withContext(parsed, options, async (context) => {
    const records = context.hub.providers.list()
    context.io.out(renderProviderTable(records, context.hub.providers.defaultModel()))
    if (records.length > 0) {
      const defaultRef = context.hub.providers.defaultModel()
      context.io.out("")
      context.io.out(`Default model: ${defaultRef ?? "(not set)"}`)
      context.io.out(`Database: ${context.dbPath}`)
    }
    return 0
  })
}

export function validateApiKeyRef(id: string, ref: string): void {
  if (REF_PATTERN.test(ref)) return
  throw new CliUsageError(
    `--api-key-ref must be a credential reference, not a key. Plaintext secrets are never stored.\n` +
      `  Use env:VAR, file:path or keychain:service, e.g. --api-key-ref env:DEEPSEEK_API_KEY\n` +
      `  To keep the key on disk: write it into ${defaultSecretPath(id).replace(/^file:/, "")} and pass\n` +
      `  --api-key-ref ${defaultSecretPath(id)}`,
  )
}

/** `--protocol` must name a protocol the bridge can actually build. */
export function parseProtocol(value: string | undefined, usage?: string): Protocol | undefined {
  if (value === undefined) return undefined
  if (!Object.prototype.hasOwnProperty.call(PROTOCOL_PACKAGES, value)) {
    throw new CliUsageError(
      `Unknown protocol "${value}". Expected one of: ${Object.keys(PROTOCOL_PACKAGES).join(", ")}.`,
      usage,
    )
  }
  return value as Protocol
}

/** The explicit notice the card requires when no credential reference is given. */
export function apiKeyNotice(id: string, presetId: string | undefined): string {
  const preset = presetId ? getPreset(presetId) : undefined
  const lines: string[] = []
  if (preset?.envKey) {
    lines.push(
      `note: no --api-key-ref given. Provider "${id}" will read ${preset.envKey} from the environment at call time; ` +
        `no secret is stored in the database.`,
    )
  } else {
    lines.push(
      `warning: no --api-key-ref given and ${preset ? `preset "${preset.id}"` : "no preset"} declares no conventional ` +
        `key variable, so calls will fail with CREDENTIAL until a key is configured.`,
    )
  }
  lines.push(`hint: mik provider add ${id} --preset <presetId> --api-key-ref ${defaultSecretPath(id)}`)
  lines.push("      (write the secret into that file, then re-run; plaintext keys are never accepted as a reference)")
  return lines.join("\n")
}

async function runAdd(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const id = requireArg(parsed, 0, "<id>", options)
  const presetId = flagString(parsed.values, "preset")
  const baseUrl = flagString(parsed.values, "baseUrl")
  const name = flagString(parsed.values, "name")
  const protocol = parseProtocol(flagString(parsed.values, "protocol"), parsed.action?.usage)
  const apiKeyRef = flagString(parsed.values, "apiKeyRef")
  if (apiKeyRef) validateApiKeyRef(id, apiKeyRef)

  return withContext(parsed, options, async (context) => {
    const { io } = context
    if (!apiKeyRef) io.out(apiKeyNotice(id, presetId))
    const record = context.hub.providers.add({ id, presetId, baseUrl, name, protocol, apiKeyRef })
    io.out("")
    io.out(`Added provider "${record.id}".`)
    io.out(
      formatTable(
        ["PROVIDER", "NAME", "PROTOCOL", "BASE URL", "KEY REF", "ENABLED"],
        [[record.id, record.name, record.protocol ?? "-", record.baseUrl ?? "-", keyRefLabel(record), record.enabled ? "yes" : "no"]],
      ),
    )
    io.out(`Updated: ${formatTimestamp(record.updatedAt)}`)
    if (!apiKeyRef) {
      io.out("")
      io.out(`Verify with: mik provider test ${record.id}`)
    }
    return 0
  })
}

async function runRemove(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const id = requireArg(parsed, 0, "<id>", options)
  return withContext(parsed, options, async (context) => {
    const { io } = context
    const existing = context.hub.providers.get(id)
    if (!existing) throw new CliRuntimeError(`Provider "${id}" is not configured.`)

    if (!flagBool(parsed.values, "yes")) {
      if (!isInteractive(options)) {
        throw new CliUsageError(
          `Refusing to remove "${id}" without --yes in a non-interactive shell. Re-run with: mik provider remove ${id} --yes`,
        )
      }
      const answer = await prompt(`Remove provider "${id}"? [y/N] `)
      if (!isAffirmative(answer)) {
        io.out("Aborted; nothing changed.")
        return 0
      }
    }

    const removed = context.hub.providers.remove(id)
    io.out(removed ? `Removed provider "${id}".` : `Provider "${id}" was already gone.`)
    io.out("Stored usage events are kept; credentials files are untouched.")
    return 0
  })
}

async function runTest(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const id = requireArg(parsed, 0, "<id>", options)
  return withContext(parsed, options, async (context) => {
    const { io } = context
    if (context.offline) {
      throw new CliRuntimeError(`"mik provider test" needs network access; --offline is set.`)
    }
    const status = await context.hub.ai.test(id)
    io.out(
      formatTable(
        ["PROVIDER", "RESULT", "LATENCY", "MODELS", "MESSAGE"],
        [
          [
            status.providerId,
            status.ok ? "ok" : "failed",
            status.latencyMs === undefined ? "-" : `${status.latencyMs} ms`,
            status.modelCount === undefined ? "-" : String(status.modelCount),
            redact(status.message),
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
      throw new CliUsageError(`Unknown provider action "${parsed.action?.name ?? ""}".`, parsed.command?.usage)
  }
}
