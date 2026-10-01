"use client"
import { useTheme } from "@/components/theme-provider"
import type { ThemePreference } from "@/lib/theme"
import { zh } from "@/lib/i18n/zh"
import { useI18n } from "@/lib/i18n/provider"

export function LangToggle() {
  const { lang, setLang, t } = useI18n()
  const { preference, setPreference } = useTheme()
  return <div className="flex items-center gap-2"><select aria-label={t("s147")} value={preference} onChange={(event) => setPreference(event.target.value as ThemePreference)} className="filter-control">{([ ["light", "s138"], ["dark", "s139"], ["system", "s140"] ] as const).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select><button type="button" data-testid="lang-toggle" aria-label={t("language.switch")} onClick={() => setLang(lang === "zh" ? "en" : "zh")} className="filter-action">{lang === "zh" ? "EN" : zh["language.name"]}</button></div>
}
