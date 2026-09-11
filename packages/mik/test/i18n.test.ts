import { describe, expect, it } from "vitest"
import { dictFor, i18nKeys, parseLangChoice, resolveLang, tr, trBoth, type Lang } from "../src/cli/i18n.js"

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

  it("resolves language from env, then stored, then zh", () => {
    expect(resolveLang("en", undefined)).toBe("en")
    expect(resolveLang(undefined, "en")).toBe("en")
    expect(resolveLang("garbage", "zh")).toBe("zh")
    expect(resolveLang(undefined, undefined)).toBe("zh")
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