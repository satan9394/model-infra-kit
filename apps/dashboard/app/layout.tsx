import type { Metadata } from "next"
import type { ReactNode } from "react"
import "./globals.css"

export const metadata: Metadata = {
  title: "mik 用量看板",
  description: "model-infra-kit 的用量、成本与请求日志看板",
}

/**
 * 根布局只负责文档骨架。带导航的完整版在 `app/(main)/layout.tsx`，
 * 无导航的嵌入版在 `app/embed/layout.tsx`——两条 URL 树共用这里。
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-[#070b16] text-slate-200 antialiased">{children}</body>
    </html>
  )
}