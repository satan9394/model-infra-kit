import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PROVIDER_PRESETS, getPreset } from "../../registry/index.js"
import type { ProviderConfig } from "../../types.js"
import { defaultDbPath } from "../../util/paths.js"
import { flagBool, flagString, type ParsedCli } from "../args.js"
import {
  DEFAULT_CONFIG_FILE,
  messageOf,
  resolveCwd,
  resolveEnv,
  resolveIo,
  withContext,
  type CliConfigFile,
  type RunOptions,
} from "../context.js"
import { CliRuntimeError, CliUsageError } from "../errors.js"
import { isInteractive, prompt } from "../prompt.js"
import { parseLangChoice, resolveCliLang, tr, type Lang } from "../i18n.js"

function presetList(): string {
  return PROVIDER_PRESETS.map((preset) => preset.id).join(", ")
}

/** The config file `mik init` writes. `initialProviders` is consumed by init only. */
export function buildConfig(appId: string, db: string, presetId: string | undefined): CliConfigFile {
  const config: CliConfigFile = { appId, db }
  if (presetId) {
    const preset = getPreset(presetId)
    const entry: ProviderConfig = { id: presetId, presetId }
    if (preset?.envKey) entry.apiKeyRef = `env:${preset.envKey}`
    config.initialProviders = [entry]
  }
  return config
}

export async function runInit(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const io = resolveIo(options)
  const cwd = resolveCwd(options)
  const interactive = isInteractive(options) && !flagBool(parsed.values, "yes")
  const force = flagBool(parsed.values, "force")
  const filePath = flagString(parsed.values, "file") ?? join(cwd, DEFAULT_CONFIG_FILE)

  if (existsSync(filePath) && !force) {
    throw new CliRuntimeError(`${filePath} already exists. Re-run with --force to overwrite it.`)
  }

  // Language resolution follows the contract MIK_LANG → cli.lang → OS locale →
  // en. The stored setting is read through the opened hub, so the
  // non-interactive path honors it too. No hardcoded default language: a user
  // who never chose one gets their system language.
  return withContext(parsed, options, async (context) => {
    const env = resolveEnv(options)
    let lang: Lang = resolveCliLang(env, context.hub.readSetting("cli.lang") ?? undefined)
    let appId = flagString(parsed.values, "appId") ?? env.MIK_APP_ID ?? "default"
    let db = flagString(parsed.values, "db") ?? env.MIK_DB ?? defaultDbPath()
    let presetId = flagString(parsed.values, "provider")

    if (interactive) {
      // First-run guide: language first (like a typical CLI onboarding), then
      // the field prompts in that language. A bogus language answer prints the
      // hint and asks once more; a second bogus answer keeps the default.
      const firstAnswer = (await prompt(tr(lang, "wizard.lang"))).trim()
      let choice = parseLangChoice(firstAnswer)
      if (!choice) {
        io.err(tr(lang, "wizard.langInvalid"))
        choice = parseLangChoice((await prompt(tr(lang, "wizard.lang"))).trim())
      }
      if (choice) lang = choice
      const answers = [
        await prompt(tr(lang, "wizard.appId", appId)),
        await prompt(tr(lang, "wizard.db", db)),
        await prompt(tr(lang, "wizard.provider", presetId ?? "")),
      ]
      appId = answers[0]?.trim() || appId
      db = answers[1]?.trim() || db
      presetId = answers[2]?.trim() || presetId
    }

    if (!appId) throw new CliUsageError("The application id cannot be empty.")
    if (presetId && !getPreset(presetId)) {
      throw new CliUsageError(`Unknown provider preset "${presetId}". Known presets: ${presetList()}.`)
    }

    const config = buildConfig(appId, db, presetId)
    writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    io.out(`Wrote ${filePath}`)
    io.out(`  appId  ${appId}`)
    io.out(`  db     ${db}`)

    context.hub.writeSetting("cli.lang", lang)

    const preset = presetId ? getPreset(presetId) : undefined
    const entry = config.initialProviders?.[0]
    if (entry) {
      try {
        const record = context.hub.providers.add(entry)
        context.io.out(`Registered provider "${record.id}" (${record.protocol}, ${record.baseUrl ?? "no base URL"}).`)
      } catch (error) {
        context.io.err(`warning: could not register provider "${entry.id}": ${messageOf(error)}`)
      }
    }
    context.io.out("")
    context.io.out(tr(lang, "wizard.done"))
    const step = (key: string) => context.io.out(`  ${tr(lang, key)}`)
    if (preset?.envKey) {
      context.io.out(`  1. set ${preset.envKey} (or use --api-key-ref file:~/.model-infra-kit/secrets/${preset.id}-api-key)`)
    } else if (presetId) {
      context.io.out(`  1. ${tr(lang, "wizard.stepSetProvider")}: mik provider add ${presetId} --api-key-ref env:VAR`)
    } else {
      context.io.out(`  1. ${tr(lang, "wizard.stepSetProvider")}: mik provider add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY`)
    }
    step("wizard.stepTest")
    step("wizard.stepModels")
    step("wizard.stepServe")
    step("wizard.stepDashboard")
    step("wizard.stepRepl")
    return 0
  })
}
