import { accessSync, constants, existsSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { archiveCutoff } from "../../usage/archive.js"
import { redact } from "../../util/redact.js"
import { flagString, type ParsedCli } from "../args.js"
import { contextLang, invocationLang, resolveCwd, resolveIo, withContext, type RunOptions } from "../context.js"
import { CliUsageError } from "../errors.js"
import { tr } from "../i18n.js"
import { verifyArchive } from "../../archive/verify-prune.js"

export async function runDb(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const lang = invocationLang(options)
  if (parsed.args.length) throw new CliUsageError(tr(lang, "db.error.args"), parsed.action?.usage)
  if (parsed.action?.name.startsWith("archive.")) return runArchive(parsed, options)
  let beforeDate: string | undefined
  let targetFile: string | undefined
  if (parsed.action?.name === "archive") {
    beforeDate = flagString(parsed.values, "before")
    const out = flagString(parsed.values, "out")
    try {
      if (!beforeDate || !out?.trim() || !out.endsWith(".jsonl") || out.includes("\0")) throw new Error()
      archiveCutoff(beforeDate)
      targetFile = resolve(resolveCwd(options), out)
      if (existsSync(targetFile) || !statSync(dirname(targetFile)).isDirectory()) throw new Error()
      accessSync(dirname(targetFile), constants.W_OK)
    } catch { throw new CliUsageError(tr(lang, "db.error.archive"), parsed.action?.usage) }
  }
  return withContext(parsed, options, async (context) => {
    const selectedLang = contextLang(context, options)
    context.io.out(tr(selectedLang, "db.scope"))
    if (parsed.action?.name === "archive") {
      const result = context.hub.usage.archive({ beforeDate: beforeDate!, targetFile: targetFile! })
      context.io.out(redact(tr(selectedLang, "db.archived", result.records, result.costMicros, result.file)))
    } else {
      const result = context.hub.usage.vacuum()
      context.io.out(tr(selectedLang, "db.vacuumed", result.beforeBytes, result.afterBytes, result.reclaimedBytes))
    }
    return 0
  })
}

async function runArchive(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const lang = invocationLang(options)
  const action = parsed.action!.name
  const manifest = flagString(parsed.values, "manifest")
  const beforeDate = flagString(parsed.values, "before")
  const out = flagString(parsed.values, "out")
  const chunk = flagString(parsed.values, "chunkSize")
  const chunkSize = chunk === undefined ? 50_000 : Number(chunk)
  try {
    if (action === "archive.export") {
      if (!beforeDate || !out || !Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error()
      archiveCutoff(beforeDate)
    } else if (!manifest) throw new Error()
  } catch { throw new CliUsageError(tr(lang, "archive.error.options"), parsed.action!.usage) }
  try {
    // Offline verification deliberately never opens or initializes a database.
    if (action === "archive.verify") {
      const result = await verifyArchive(resolve(resolveCwd(options), manifest!))
      resolveIo(options).out(tr(lang, "archive.verified", result.totalRecords, result.totalCostMicros, result.totalSavingsMicros))
      return 0
    }
    return await withContext(parsed, options, async context => {
      const selectedLang = contextLang(context, options)
      context.io.out(tr(selectedLang, "archive.scope"))
      if (action === "archive.export") {
        const path = await context.hub.usage.exportArchive({ beforeDate: beforeDate!, outDir: resolve(resolveCwd(options), out!), chunkSize })
        context.io.out(redact(tr(selectedLang, "archive.exported", path)))
      } else {
        const count = await context.hub.usage.pruneArchived(resolve(resolveCwd(options), manifest!), { vacuum: parsed.values.vacuum === true })
        context.io.out(tr(selectedLang, "archive.pruned", count))
      }
      return 0
    })
  } catch (error) { throw new Error(redact(tr(lang, "archive.failed", error instanceof Error ? error.message : String(error)))) }
}
