import type { ReactNode } from "react"
import { Nav } from "@/components/nav"
import { mikServerUrl } from "@/lib/config"

/** 完整版布局：全局导航 + 页脚。URL 保持 `/`、`/trends` 等不变。 */
export default function MainLayout({ children }: { children: ReactNode }) {
  const serverUrl = mikServerUrl()
  return (
    <>
      <Nav />
      <main className="mx-auto w-full max-w-7xl px-5 pb-20 pt-6">{children}</main>
      <footer className="mx-auto w-full max-w-7xl px-5 pb-8 text-xs text-slate-500">
        数据源 <code className="text-slate-400">{serverUrl}</code>（MIK_SERVER_URL）· 看板不直连 SQLite
      </footer>
    </>
  )
}