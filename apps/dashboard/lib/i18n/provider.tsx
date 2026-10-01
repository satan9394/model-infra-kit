"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { LANG_STORAGE_KEY, resolveLang, translator, type Lang } from "./core"

const I18nContext = createContext({ lang: "zh" as Lang, t: translator("zh"), setLang: (_lang: Lang) => {} })

export function I18nProvider({ initialLang, children }: { initialLang: Lang; children: ReactNode }) {
  const router = useRouter()
  const [lang, setCurrent] = useState(initialLang)
  function setLang(next: Lang) {
    setCurrent(next)
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en"
    document.cookie = `${LANG_STORAGE_KEY}=${next}; Path=/; SameSite=Lax`
    try { localStorage.setItem(LANG_STORAGE_KEY, next) } catch { /* The active language still works without storage. */ }
    router.refresh()
  }
  useEffect(() => {
    let stored: string | null = null
    try { stored = localStorage.getItem(LANG_STORAGE_KEY) } catch { /* Browser preference is the fallback. */ }
    const next = resolveLang(stored, navigator.language)
    if (next !== initialLang) setLang(next)
    // Apply the preference only at hydration; subsequent changes use setLang.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <I18nContext.Provider value={{ lang, t: translator(lang), setLang }}>{children}</I18nContext.Provider>
}

export function useI18n() { return useContext(I18nContext) }
