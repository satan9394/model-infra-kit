import { getI18n } from "@/lib/i18n/server"
import type { ReactNode } from "react"

/**
 * 嵌入版布局：没有全局导航与页脚，适合 iframe / 宿主页面 /usage/* 反向代理。
 * 数据源仍是 mik serve 的 HTTP API（MIK_SERVER_URL，服务端环境变量）。
 */
export default async function EmbedLayout({ children }: { children: ReactNode }) {
  const { t } = await getI18n()

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-8 pt-4">
      {children}
      <p className="mt-8 border-t border-border pt-3 text-right text-[11px] text-subtle/85"> {t("s374")} <a className="underline" href="/"> {t("s375")} </a>
      </p>
    </main>
  )
}