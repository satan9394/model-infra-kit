/**
 * Minimal zh/en localization for user-facing CLI surfaces (REPL, first-run
 * wizard, guided output). Scope is intentionally small: structural output
 * (tables, numbers) stays language-neutral; these keys cover words, hints and
 * next-step guidance.
 *
 * The strings themselves live one file per language (`./i18n/zh.ts`,
 * `./i18n/en.ts`) and are composed here into a single catalog. Adding a language
 * is "add one file + register it in `LANGS`/`LANG_DICTS`"; key-set parity is
 * enforced by `test/i18n.test.ts`, so a half-translated language cannot ship.
 */
import { en } from "./i18n/en.js"
import { zh } from "./i18n/zh.js"

export type Lang = "zh" | "en"

export const LANGS: readonly Lang[] = ["zh", "en"]
export const LANG_LABELS: Record<Lang, string> = { zh: "中文", en: "English" }

/** One language file: flat `key → text`. */
export type LangDict = Record<string, string>

/**
 * Merged catalog: one row per key, holding only the languages that define it.
 * Values are partial on purpose — a key missing from one language must fall back
 * to the other language, never echo itself (that is how G05 leaked the debug key
 * `repl.prompt` into the REPL prompt).
 */
export type Catalog = Record<string, Partial<Record<Lang, string>>>

/** Registered language files, in `LANGS` order (first = preferred fallback order). */
export const LANG_DICTS: Record<Lang, LangDict> = { zh, en }

/** Merge per-language files into the keyed catalog. */
export function buildCatalog(dicts: Record<Lang, LangDict>): Catalog {
  const catalog: Catalog = {}
  for (const lang of LANGS) {
    for (const [key, text] of Object.entries(dicts[lang] ?? {})) {
      const row = catalog[key] ?? {}
      row[lang] = text
      catalog[key] = row
    }
  }
  return catalog
}

const CATALOG: Catalog = buildCatalog(LANG_DICTS)

/**
 * Shown when a key exists in no language file at all. Deliberately *not* the key
 * itself: a missing translation must never surface a debug key name to the user.
 * `hasKey()` / `i18nKeys()` are the developer-facing guards.
 */
export const MISSING_TEXT = ""

export function hasKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, key)
}

/** All catalog keys, for parity tests. */
export function i18nKeys(): readonly string[] {
  return Object.keys(CATALOG)
}

/**
 * Text for `key` in `lang`, falling back to `en` and then to the other language
 * (the requested language always wins when it defines the key). `undefined` only
 * when no language defines the key.
 */
export function textFor(catalog: Catalog, lang: Lang, key: string): string | undefined {
  const row = catalog[key]
  if (!row) return undefined
  const order: readonly Lang[] = lang === "en" ? ["en", "zh"] : ["zh", "en"]
  for (const candidate of order) {
    const text = row[candidate]
    if (text) return text
  }
  return undefined
}

function fill(text: string, args: readonly unknown[]): string {
  let out = text
  for (const arg of args) out = out.replace("%s", String(arg))
  return out
}

/** Translate `key` with positional `%s` args (kept in English for numbers/paths). */
export function tr(lang: Lang, key: string, ...args: unknown[]): string {
  const text = textFor(CATALOG, lang, key)
  if (text === undefined) return MISSING_TEXT
  return fill(text, args)
}

/** Both languages side by side, e.g. for slash-command help. */
export function trBoth(key: string): string {
  const parts = LANGS.map((lang) => textFor(CATALOG, lang, key)).filter((text): text is string => Boolean(text))
  return parts.length > 0 ? parts.join(" / ") : MISSING_TEXT
}

/** Every key as a flat record for a language, for callers that pass keys around. */
export function dictFor(lang: Lang): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of i18nKeys()) out[key] = tr(lang, key)
  return out
}

export function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en"
}

export interface LangResolveOptions {
  /** Environment to read the OS locale from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * Injected OS locale (e.g. `"zh_CN.UTF-8"`). An explicit value — including the
   * empty string — short-circuits both the env probe and `Intl`, so tests never
   * depend on the machine they run on.
   */
  locale?: string
  /**
   * Platform gate for the Windows-only `Intl` probe. The CLI passes
   * `process.platform` so a Windows box without `LANG` still detects its system
   * language; leaving it unset keeps the default deterministic (env vars only),
   * which is what embedders and unit tests want.
   */
  platform?: NodeJS.Platform
}

/**
 * The raw OS locale according to the documented probe order:
 * `LC_ALL` → `LC_MESSAGES` → `LANG` → (Windows) `Intl`.
 */
export function osLocale(options: LangResolveOptions = {}): string | undefined {
  if (options.locale !== undefined) return options.locale
  const env = options.env ?? process.env
  const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG
  if (fromEnv) return fromEnv
  if (options.platform === "win32") {
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Map a raw locale to a supported language: `zh*` → `zh`, and everything else —
 * including malformed values such as `C`, `POSIX` or an empty string, which
 * carry no usable hint — → `en`, the international fallback. Never throws.
 */
export function langFromLocale(locale: string | undefined): Lang {
  if (!locale) return "en"
  const normalized = locale.trim().toLowerCase().replace(/-/g, "_")
  const head = normalized.split(/[._@]/)[0] ?? ""
  return head === "zh" ? "zh" : "en"
}

/**
 * Language for this invocation: `MIK_LANG` → stored `cli.lang` → OS locale →
 * `en`. An unsupported value (`MIK_LANG=xx`) counts as *unset* and resolution
 * continues down the chain — it never throws and never silently becomes `zh`.
 */
export function resolveLang(value: string | undefined, stored: string | undefined, options: LangResolveOptions = {}): Lang {
  if (isLang(value)) return value
  if (isLang(stored)) return stored
  return langFromLocale(osLocale(options))
}

/**
 * `resolveLang` wired for a real CLI invocation: the language is the injected
 * environment plus the real platform (so Windows, which normally has no `LANG`,
 * still consults `Intl`). Every CLI entry point uses this, so `init`, the REPL
 * and the non-TTY guard can never disagree about the default language.
 */
export function resolveCliLang(env: NodeJS.ProcessEnv, stored: string | undefined): Lang {
  return resolveLang(env.MIK_LANG, stored, { env, platform: process.platform })
}

/** Map a wizard/`/lang` answer ("1" | "2" | "zh" | "en") to a Lang or null. */
export function parseLangChoice(value: string): Lang | null {
  const v = value.trim().toLowerCase()
  if (v === "1" || v === "zh") return "zh"
  if (v === "2" || v === "en") return "en"
  return null
}
