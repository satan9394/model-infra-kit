import { getI18n } from "@/lib/i18n/server"
import type { ReactNode } from "react"
import { LangToggle } from "@/components/lang-toggle"
import { Nav } from "@/components/nav"
import { BudgetPill } from "@/components/budget-pill"
import { mikServerUrl } from "@/lib/config"

/** 完整版布局：全局导航 + 页脚。URL 保持 `/`、`/trends` 等不变。 */
export default async function MainLayout({ children }: { children: ReactNode }) {
  const { t } = await getI18n()

  const serverUrl = mikServerUrl()
  return (
    <div className="dashboard-shell">
      <a href="#main-content" className="skip-link"> {t("s366")} </a>
      <Nav />
      <div className="dashboard-workspace">
        <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-8"><BudgetPill /><LangToggle /></header>
        <main id="main-content" tabIndex={-1} className="dashboard-content">{children}</main>
        <footer className="dashboard-footer">
          <span>model-infra-kit <span className="mx-2 text-border-strong">/</span> {t("s367")} </span>
          <span> {t("s368")} <code className="text-muted-foreground">{serverUrl}</code></span>
        </footer>
      </div>
    </div>
  )
}
