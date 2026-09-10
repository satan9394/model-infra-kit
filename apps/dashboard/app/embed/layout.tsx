import type { ReactNode } from "react"

/**
 * 嵌入版布局：没有全局导航与页脚，适合 iframe / 宿主页面 /usage/* 反向代理。
 * 数据源仍是 mik serve 的 HTTP API（MIK_SERVER_URL，服务端环境变量）。
 */
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-8 pt-4">
      {children}
      <p className="mt-8 border-t border-slate-800/80 pt-3 text-right text-[11px] text-slate-600">
        由 model-infra-kit 看板提供 · <a className="underline" href="/">完整版</a>
      </p>
    </main>
  )
}