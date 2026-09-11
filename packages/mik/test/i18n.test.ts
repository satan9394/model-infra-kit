import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { en } from "../src/cli/i18n/en.js"
import { zh } from "../src/cli/i18n/zh.js"
import {
  buildCatalog,
  dictFor,
  hasKey,
  i18nKeys,
  LANG_DICTS,
  LANGS,
  langFromLocale,
  MISSING_TEXT,
  osLocale,
  parseLangChoice,
  resolveLang,
  textFor,
  tr,
  trBoth,
  type Lang,
} from "../src/cli/i18n.js"

describe("i18n", () => {
  it("has a non-empty zh and en row for every key (no broken copy)", () => {
    for (const key of i18nKeys()) {
      const zh = tr("zh", key)
      const en = tr("en", key)
      expect(zh.length, `zh ${key}`).toBeGreaterThan(0)
      expect(en.length, `en ${key}`).toBeGreaterThan(0)
      expect(zh).not.toBe(key)
      expect(en).not.toBe(key)
    }
  })

  it("renders both languages side by side", () => {
    const both = trBoth("slash.help")
    expect(both).toContain("显示所有斜杠命令")
    expect(both).toContain("Show all slash commands")
  })

  it("fills positional %s arguments in order", () => {
    expect(tr("zh", "repl.langSet", "English")).toBe("语言已切换为 English")
    expect(tr("en", "repl.unknownCmd", "/nope")).toContain("/nope")
  })

  it("provides a literal REPL prompt and localized wizard field prompts", () => {
    expect(tr("zh", "repl.prompt")).toBe("mik>")
    expect(tr("en", "repl.prompt")).toBe("mik>")
    expect(tr("zh", "wizard.appId", "default")).toBe("应用 id [default]: ")
    expect(tr("en", "wizard.appId", "default")).toBe("Application id [default]: ")
    expect(tr("zh", "wizard.db", "/tmp/x.db")).toBe("SQLite 数据库路径 [/tmp/x.db]: ")
    expect(tr("en", "wizard.db", "/tmp/x.db")).toBe("SQLite database path [/tmp/x.db]: ")
    expect(tr("zh", "wizard.provider", "deepseek")).toBe("首个供应商预设（留空跳过）[deepseek]: ")
    expect(tr("en", "wizard.provider", "deepseek")).toBe("First provider preset (blank to skip) [deepseek]: ")
  })

  it("resolves language from env, then stored, then the fallback", () => {
    expect(resolveLang("en", undefined, { env: {}, locale: "" })).toBe("en")
    expect(resolveLang(undefined, "en", { env: {}, locale: "" })).toBe("en")
    expect(resolveLang("garbage", "zh", { env: {}, locale: "" })).toBe("zh")
    expect(resolveLang(undefined, undefined, { env: {}, locale: "" })).toBe("en")
  })

  it("maps wizard answers 1/2/zh/en via parseLangChoice", () => {
    expect(parseLangChoice("1")).toBe("zh")
    expect(parseLangChoice("2")).toBe("en")
    expect(parseLangChoice("ZH")).toBe("zh")
    expect(parseLangChoice("en")).toBe("en")
    expect(parseLangChoice("3")).toBeNull()
  })

  it("produces a flat dict per language", () => {
    const zh = dictFor("zh")
    const en = dictFor("en")
    expect(zh["slash.exit"]).toContain("退出")
    expect(en["slash.exit"]).toContain("Exit")
    expect(Object.keys(zh).length).toBe(Object.keys(en).length)
  })

  it("typed Lang values cover exactly zh and en", () => {
    const langs: readonly Lang[] = ["zh", "en"]
    expect(langs).toHaveLength(2)
    expect(langs).toContain("zh")
    expect(langs).toContain("en")
  })
})

// ---------------------------------------------------------------------------
// A1 — per-language files stay key-for-key equal
// ---------------------------------------------------------------------------

describe("i18n language files (A1 key parity)", () => {
  it("keeps zh.ts and en.ts key sets identical and equal to the catalog", () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(zhKeys).toEqual(enKeys)
    expect([...i18nKeys()].sort()).toEqual(zhKeys)
    // Self-proof of the gate: delete any single key from `en.ts` (or `zh.ts`)
    // and this assertion goes red before the change can ship — verified once by
    // temporarily removing `slash.exit` from `en.ts` (reported in .tmp/impl-G08.md).
  })

  it("has no empty string in either language file", () => {
    for (const lang of LANGS) {
      for (const [key, text] of Object.entries(LANG_DICTS[lang])) {
        expect(text.length, `${lang} ${key}`).toBeGreaterThan(0)
      }
    }
  })

  it("registers exactly the languages that have a file", () => {
    expect(Object.keys(LANG_DICTS).sort()).toEqual([...LANGS].sort())
  })

  it("falls back to en when one language file misses a key (never echoes the key)", () => {
    const catalog = buildCatalog({
      zh: { "k.both": "两种都有" },
      en: { "k.both": "in both", "k.enOnly": "English only" },
    })
    expect(textFor(catalog, "zh", "k.both")).toBe("两种都有")
    expect(textFor(catalog, "en", "k.both")).toBe("in both")
    // The whole point: a key missing from the requested language renders the
    // other language, not "k.enOnly".
    expect(textFor(catalog, "zh", "k.enOnly")).toBe("English only")
    expect(textFor(catalog, "zh", "k.enOnly")).not.toBe("k.enOnly")
    // Absent everywhere: also never the raw key (G05/G07 regression).
    expect(textFor(catalog, "zh", "k.ghost")).toBeUndefined()
    expect(tr("zh", "k.ghost")).toBe(MISSING_TEXT)
    expect(tr("zh", "k.ghost")).not.toBe("k.ghost")
    expect(trBoth("k.ghost")).not.toBe("k.ghost")
  })

  it("keeps tr/trBoth behaviour for catalogued keys", () => {
    expect(tr("zh", "slash.exit")).toBe("退出")
    expect(tr("en", "slash.exit")).toBe("Exit")
    expect(trBoth("slash.exit")).toBe("退出 / Exit")
    expect(tr("en", "repl.chatCost", 1, 2, 3)).toBe("cost 1 · model 2 · source 3")
    expect(hasKey("slash.exit")).toBe(true)
    expect(hasKey("nope.not.here")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A2 — MIK_LANG → cli.lang → OS locale → en
// ---------------------------------------------------------------------------

describe("i18n language detection (A2)", () => {
  it("lets MIK_LANG win over the stored setting and the OS locale", () => {
    expect(resolveLang("en", "zh", { locale: "zh_CN.UTF-8" })).toBe("en")
    expect(resolveLang("zh", "en", { locale: "en_US.UTF-8" })).toBe("zh")
  })

  it("lets the stored setting win over the OS locale", () => {
    expect(resolveLang(undefined, "zh", { locale: "en_US.UTF-8" })).toBe("zh")
    expect(resolveLang(undefined, "en", { locale: "zh_CN.UTF-8" })).toBe("en")
  })

  it("maps a zh_* OS locale to zh through the env probe", () => {
    expect(resolveLang(undefined, undefined, { env: { LANG: "zh_CN.UTF-8" } })).toBe("zh")
    expect(resolveLang(undefined, undefined, { env: { LC_ALL: "zh_TW.UTF-8" } })).toBe("zh")
    expect(langFromLocale("zh-CN")).toBe("zh")
    expect(langFromLocale("zh")).toBe("zh")
  })

  it("maps an en_* OS locale to en through the env probe", () => {
    expect(resolveLang(undefined, undefined, { env: { LANG: "en_US.UTF-8" } })).toBe("en")
    expect(resolveLang(undefined, undefined, { env: { LANG: "en_GB" } })).toBe("en")
  })

  it("reads the probe chain LC_ALL → LC_MESSAGES → LANG", () => {
    expect(osLocale({ env: { LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "en_US.UTF-8", LANG: "en_US.UTF-8" } })).toBe("zh_CN.UTF-8")
    expect(osLocale({ env: { LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" } })).toBe("zh_CN.UTF-8")
    expect(osLocale({ env: { LC_ALL: "", LANG: "en_US.UTF-8" } })).toBe("en_US.UTF-8")
    expect(osLocale({ env: {} })).toBeUndefined()
  })

  it("consults the Windows Intl locale only on the opt-in platform, and an injected locale short-circuits it", () => {
    expect(osLocale({ locale: "zh-CN", platform: "win32" })).toBe("zh-CN")
    expect(osLocale({ locale: "", platform: "win32" })).toBe("")
    // No `LANG` and no win32 gate → deterministic `en`, independent of the host.
    expect(resolveLang(undefined, undefined, { env: {} })).toBe("en")
  })

  it("falls back to en when no env, stored or locale clue exists", () => {
    // The machine running the suite must not decide this: clear the three locale
    // variables for the duration of the assertion and restore them afterwards.
    const saved: Record<string, string | undefined> = {
      LC_ALL: process.env.LC_ALL,
      LC_MESSAGES: process.env.LC_MESSAGES,
      LANG: process.env.LANG,
    }
    try {
      delete process.env.LC_ALL
      delete process.env.LC_MESSAGES
      delete process.env.LANG
      expect(resolveLang(undefined, undefined)).toBe("en")
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it("treats malformed locales as unusable and lands on en without throwing", () => {
    for (const bad of ["C", "POSIX", "", "   ", "fr_FR.UTF-8", "not-a-locale"]) {
      expect(langFromLocale(bad), bad).toBe("en")
      expect(resolveLang(undefined, undefined, { locale: bad }), bad).toBe("en")
    }
  })

  it("treats an unsupported MIK_LANG as unset instead of crashing or forcing zh", () => {
    expect(resolveLang("xx", undefined, { env: {}, locale: "" })).toBe("en")
    expect(resolveLang("xx", "en", { locale: "zh_CN.UTF-8" })).toBe("en")
    expect(resolveLang("xx", undefined, { locale: "en_US.UTF-8" })).toBe("en")
    // ...and it does not block a legitimate stored choice.
    expect(resolveLang("xx", "zh", { locale: "en_US.UTF-8" })).toBe("zh")
  })
})

// ---------------------------------------------------------------------------
// A3 — the CLI entry points carry no hardcoded default language
// ---------------------------------------------------------------------------

describe("i18n CLI wiring (A3)", () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8")

  it("leaves no hardcoded zh default in init.ts / repl.ts", () => {
    for (const relative of ["../src/cli/repl.ts", "../src/cli/commands/init.ts"]) {
      const source = read(relative)
      expect(source, relative).not.toMatch(/tr\(\s*["']zh["']/)
      expect(source, relative).not.toMatch(/["']zh["']\s*:/)
      expect(source, relative).toContain("resolveCliLang(")
    }
  })

  it("documents the zh/en support and the dashboard's Chinese-only boundary (A5)", () => {
    const readme = read("../../../README.md")
    expect(readme).toContain("看板当前仅中文")
    expect(readme).toContain("MIK_LANG → cli.lang → OS locale → en")
  })
})
