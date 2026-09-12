import { existsSync, readFileSync, writeFileSync } from "node:fs"
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
import { redact } from "../../util/redact.js"

function presetList(): string {
  return PROVIDER_PRESETS.map((preset) => preset.id).join(", ")
}

/**
 * The config file `mik init` writes. `initialProviders` is consumed by init only.
 *
 * EVO-G84 (F11): `cacheDir` is written whenever the invocation named one. Dropping it
 * meant `--cache-dir <dir>` looked accepted while every later command still fell back
 * to `~/.model-infra-kit/cache` — the audit reproduced exactly that (R232/F11).
 */
export function buildConfig(
  appId: string,
  db: string,
  presetId: string | undefined,
  cacheDir?: string,
): CliConfigFile {
  const config: CliConfigFile = { appId, db }
  if (cacheDir) config.cacheDir = cacheDir
  if (presetId) {
    const preset = getPreset(presetId)
    const entry: ProviderConfig = { id: presetId, presetId }
    if (preset?.envKey) entry.apiKeyRef = `env:${preset.envKey}`
    config.initialProviders = [entry]
  }
  return config
}

/**
 * The `cacheDir` already recorded in the config file this run is about to rewrite.
 *
 * EVO-G88: EVO-G84 made `init --cache-dir` write the field, but a later run
 * **without** the flag rebuilt the file from scratch and dropped it — the install
 * silently went back to `~/.model-infra-kit/cache`, i.e. the card's own bug class
 * ("silently undoing a configuration the user made") left in place one command
 * later. The flag still wins; this is only the last resort before "unset".
 *
 * A missing file, unreadable JSON or a non-string value is simply "no stored
 * value": `init` must never fail because of the file it is replacing. The type
 * check matches `context.openContext`, so the value preserved here is exactly a
 * value a later command would have honoured.
 */
function storedCacheDir(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null) return undefined
    const value = (parsed as Record<string, unknown>).cacheDir
    return typeof value === "string" && value.trim() !== "" ? value : undefined
  } catch {
    return undefined
  }
}

export async function runInit(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const io = resolveIo(options)
  const cwd = resolveCwd(options)
  const interactive = isInteractive(options) && !flagBool(parsed.values, "yes")
  const force = flagBool(parsed.values, "force")
  const filePath = flagString(parsed.values, "file") ?? join(cwd, DEFAULT_CONFIG_FILE)

  // Language resolution follows the contract MIK_LANG → cli.lang → OS locale →
  // en. The stored setting needs an open hub, so the flag-only subset is used
  // for messages raised before `withContext` (e.g. the `--force` guard); inside
  // the callback the stored preference is folded in and wins over the guess.
  // No hardcoded default language: a user who never chose one gets their system
  // language. Every user-visible line below goes through `tr()`, so `init`
  // output is fully localized.
  const earlyLang: Lang = resolveCliLang(resolveEnv(options), undefined)
  if (existsSync(filePath) && !force) {
    throw new CliRuntimeError(tr(earlyLang, "init.exists", filePath))
  }

  return withContext(parsed, options, async (context) => {
    const env = resolveEnv(options)
    let lang: Lang = resolveCliLang(env, context.hub.readSetting("cli.lang") ?? undefined)
    let appId = flagString(parsed.values, "appId") ?? env.MIK_APP_ID ?? "default"
    let db = flagString(parsed.values, "db") ?? env.MIK_DB ?? defaultDbPath()
    let presetId = flagString(parsed.values, "provider")
    // Same precedence `openContext` uses (flag → env → file), so what init persists
    // is exactly what a later command would have resolved anyway. The file is the
    // file this run is rewriting (`--file`), not the one `openContext` reads
    // (`--config`): the value at risk is the one being replaced.
    const cacheDir = flagString(parsed.values, "cacheDir") ?? env.MIK_CACHE_DIR ?? storedCacheDir(filePath)

    if (interactive) {
      // First-run guide: language first (like a typical CLI onboarding), then
      // the field prompts in that language. A bogus language answer prints the
      // hint and asks once more; a second bogus answer prints the same hint
      // again (EVO-G11 / G15: it used to fall back to the default silently)
      // and then keeps the resolved default.
      const firstAnswer = (await prompt(tr(lang, "wizard.lang"))).trim()
      let choice = parseLangChoice(firstAnswer)
      if (!choice) {
        io.err(tr(lang, "wizard.langInvalid"))
        choice = parseLangChoice((await prompt(tr(lang, "wizard.lang"))).trim())
        if (!choice) io.err(tr(lang, "wizard.langInvalid"))
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

    if (!appId) throw new CliUsageError(tr(lang, "init.appIdEmpty"))
    if (presetId && !getPreset(presetId)) {
      throw new CliUsageError(tr(lang, "init.unknownPreset", presetId, presetList()))
    }

    const config = buildConfig(appId, db, presetId, cacheDir)
    writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    io.out(tr(lang, "init.wrote", filePath))
    io.out(tr(lang, "init.appIdLine", appId))
    io.out(tr(lang, "init.dbLine", db))
    // EVO-G88: `cacheDir` was the one field init persisted but never named, which is
    // why losing it on a re-run was invisible. Printed only when a value is in
    // effect (flag, env or the file it kept): with none, there is nothing to claim.
    if (cacheDir) io.out(tr(lang, "init.cacheDirLine", cacheDir))

    context.hub.writeSetting("cli.lang", lang)

    const preset = presetId ? getPreset(presetId) : undefined
    const entry = config.initialProviders?.[0]
    if (entry) {
      try {
        const record = context.hub.providers.add(entry)
        context.io.out(
          tr(
            lang,
            "init.providerRegistered",
            record.id,
            record.protocol,
            record.baseUrl ?? tr(lang, "init.noBaseUrl"),
          ),
        )
      } catch (error) {
        // Error text goes through `redact()`; the message template is localized.
        context.io.err(tr(lang, "init.providerRegisterFailed", entry.id, redact(messageOf(error))))
      }
    }
    context.io.out("")
    context.io.out(tr(lang, "wizard.done"))
    const step = (key: string) => context.io.out(`  ${tr(lang, key)}`)
    // EVO-G15 (G59/G62): a genuinely numbered three-step path that ends on a real
    // call. Step 1 is always numbered; the extras below stay unnumbered so "1/2/3"
    // reads as the path and everything else reads as optional.
    if (preset?.envKey) {
      context.io.out(tr(lang, "init.stepSetEnvKey", preset.envKey, preset.id))
    } else if (presetId) {
      context.io.out(tr(lang, "init.stepAddProvider", tr(lang, "wizard.stepSetProvider"), presetId))
    } else {
      context.io.out(tr(lang, "init.stepAddFirstProvider", tr(lang, "wizard.stepSetProvider"), presetList()))
    }
    step("wizard.stepServe")
    step("wizard.stepFirstCall")
    context.io.out(tr(lang, "wizard.stepFirstCallCmd"))
    step("wizard.stepTest")
    step("wizard.stepModels")
    // EVO-G84 (F10): this line used to read `mik dashboard`, which a packaged install
    // cannot run at all — `apps/dashboard` is not in the tarball
    // (`files: ["dist", "LICENSE"]`), so the guidance promised a step that failed on
    // the spot. Every line here now names a command the npm-installed CLI can execute.
    step("wizard.stepUsage")
    step("wizard.stepRepl")
    return 0
  })
}
