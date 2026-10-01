import { en } from "./en.ts"
import { zh } from "./zh.ts"

export type Lang = "zh" | "en"
export type MessageKey = keyof typeof zh
export const LANG_STORAGE_KEY = "mik_dashboard_lang"
export function resolveLang(stored: string | null | undefined, browser = "zh"): Lang {
  return stored === "en" || stored === "zh" ? stored : browser.toLowerCase().startsWith("zh") ? "zh" : "en"
}

export function translator(lang: Lang) {
  return (key: MessageKey | string, ...args: unknown[]): string => {
    const dict = lang === "en" ? en : zh
    if (Object.hasOwn(zh, key)) return dict[key as MessageKey].replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? ""))
    // Labels and validation messages from pure data helpers use the same dictionary.
    for (const id of Object.keys(zh) as MessageKey[]) {
      const text = zh[id]
      if (text === key) return dict[id]
      if (text.includes("{0}")) {
        const pattern = text.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*?)")
        const match = new RegExp(`^${pattern}$`).exec(key)
        if (match) return dict[id].replace(/\{(\d+)\}/g, (_, index) => match[Number(index) + 1] ?? "")
      }
    }
    return key
  }
}

/** Pure helpers return Chinese labels; the rendering boundary selects the language. */
export const message = translator("zh")
