import { accessSync, constants, existsSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { archiveCutoff } from "../../usage/archive.js"
import { redact } from "../../util/redact.js"
import { flagString, type ParsedCli } from "../args.js"
import { contextLang, invocationLang, resolveCwd, withContext, type RunOptions } from "../context.js"
import { CliUsageError } from "../errors.js"
import { tr } from "../i18n.js"

export async function runDb(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const lang = invocationLang(options)
  if (parsed.args.length) throw new CliUsageError(tr(lang, "db.error.args"), parsed.action?.usage)
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
