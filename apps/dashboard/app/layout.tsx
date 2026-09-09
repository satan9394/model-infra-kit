import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./globals.css"
import { Nav } from "@/components/nav"
import { mikServerUrl } from "@/lib/config"

export const metadata: Metadata = {
  title: "mik 用量看板",
  description: "model-infra-kit 的用量、成本与请求日志看板",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const serverUrl = mikServerUrl()
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-[#070b16] text-slate-200 antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-7xl px-5 pb-20 pt-6">{children}</main>
        <footer className="mx-auto w-full max-w-7xl px-5 pb-8 text-xs text-slate-500">
          数据源 <code className="text-slate-400">{serverUrl}</code>（MIK_SERVER_URL）· 看板不直连 SQLite
        </footer>
      </body>
    </html>
  )
}
