import type { ReactNode } from "react"
import { Nav } from "@/components/nav"
import { BudgetPill } from "@/components/budget-pill"
import { mikServerUrl } from "@/lib/config"

/** 完整版布局：全局导航 + 页脚。URL 保持 `/`、`/trends` 等不变。 */
export default function MainLayout({ children }: { children: ReactNode }) {
  const serverUrl = mikServerUrl()
  return (
    <div className="dashboard-shell">
      <a href="#main-content" className="skip-link">跳转到主要内容</a>
      <Nav />
      <div className="dashboard-workspace">
        <div className="px-4 sm:px-8"><BudgetPill /></div>
        <main id="main-content" tabIndex={-1} className="dashboard-content">{children}</main>
        <footer className="dashboard-footer">
          <span>model-infra-kit <span className="mx-2 text-border-strong">/</span> 用量看板</span>
          <span>数据源 <code className="text-muted-foreground">{serverUrl}</code></span>
        </footer>
      </div>
    </div>
  )
}
