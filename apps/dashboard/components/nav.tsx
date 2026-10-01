"use client"

import { useI18n } from "@/lib/i18n/provider"
import { message } from "@/lib/i18n/core"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "@/components/theme-provider"
import type { ThemePreference } from "@/lib/theme"

const LINKS = [
  { href: "/", label: message("s125"), hint: message("s126"), icon: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z" },
  { href: "/trends", label: message("s127"), hint: message("s128"), icon: "M3 3v18h18 M6 15l4-5 4 3 6-8" },
  { href: "/traces", label: message("s129"), hint: message("s130"), icon: "M5 4v12a4 4 0 0 0 4 4h7 M5 8h11 M16 5l3 3-3 3 M16 17l3 3-3 3" },
  { href: "/logs", label: message("s131"), hint: message("s132"), icon: "M8 3h8l4 4v14H4V3h4 M8 11h8 M8 15h8 M8 7h3" },
  { href: "/providers", label: message("s87"), hint: message("s133"), icon: "M8 3v5 M16 3v5 M5 8h14v3a7 7 0 0 1-14 0V8 M12 18v3" },
  { href: "/models", label: message("s134"), hint: message("s135"), icon: "m12 3 9 5-9 5-9-5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5" },
  { href: "/connect", label: "connect.title", hint: "connect.description", icon: "m13 2-8 12h6l-1 8 9-12h-6z" },
  { href: "/pricing", label: message("s136"), hint: message("s137"), icon: "M3 3h8l10 10-8 8L3 11V3z M7 7h.01" },
] as const

function NavIcon({ path }: { path: string }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
}

export function Nav() {
  const { t } = useI18n()

  const pathname = usePathname()
  const { preference, setPreference } = useTheme()
  const themeOptions: ReadonlyArray<{ value: ThemePreference; icon: string; label: string }> = [
    { value: "light", icon: "M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M5.6 18.4 7 17 M17 7l1.4-1.4 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0", label: t("s138") },
    { value: "dark", icon: "M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z", label: t("s139") },
    { value: "system", icon: "M3 4h18v13H3z M8 21h8 M12 17v4", label: t("s140") },
  ]

  return (
    <aside className="dashboard-nav">
      <Link href="/" className="dashboard-brand" aria-label={t("s141")}>
        <span className="brand-mark" aria-hidden="true"><svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17V7l5 5 4-5v10 M17 7v10 M21 7v10" /></svg></span>
        <span><span className="block text-xl font-semibold tracking-tight">mik<span className="ml-1.5 text-sm font-normal text-subtle">console</span></span><span className="brand-caption"> {t("s142")} </span></span>
      </Link>
      <nav className="dashboard-nav-links" aria-label={t("s143")}>
        <p className="nav-group-label"> {t("s144")} </p>
        {LINKS.map((link, index) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href)
          return (
            <div key={link.href} className="nav-item">
              {index === 4 ? <p className="nav-group-label mt-7"> {t("s145")} </p> : null}
              <Link href={link.href} title={t(link.hint)} aria-current={active ? "page" : undefined} className={`nav-link ${active ? "nav-link-active" : ""}`}>
                <NavIcon path={link.icon} /><span>{t(link.label)}</span>
                {active ? <span className="nav-active-dot" aria-hidden="true" /> : null}
              </Link>
            </div>
          )
        })}
      </nav>
      <div className="nav-footer">
        <div className="nav-product-note"><span className="block font-medium text-foreground">model-infra-kit</span><span className="mt-1 block"> {t("s146")} </span></div>
        <div className="theme-switch" role="group" aria-label={t("s147")}>
          {themeOptions.map((option) => (
            <button key={option.value} type="button" aria-label={t("s148", t(option.label))} aria-pressed={preference === option.value} title={t(option.label)} onClick={() => setPreference(option.value)} className={`theme-option ${preference === option.value ? "theme-option-active" : ""}`}>
              <NavIcon path={option.icon} /><span>{option.value === "system" ? t("s149") : t(option.label)}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
