import { getI18n } from "@/lib/i18n/server"
import { EmbedShell } from "@/components/embed-shell"
import { ConnectionProbeProvider } from "@/components/connection-probe-provider"
import { parseAllowedOrigins } from "@/lib/embed-bridge"
import type { ReactNode } from "react"

/**
 * 嵌入版布局：没有全局导航与页脚，适合 iframe / 宿主页面 /usage/* 反向代理。
 * 数据源仍是 mik serve 的 HTTP API（MIK_SERVER_URL，服务端环境变量）。
 *
 * The shell adds the security-checked postMessage bridge and auto-resize.
 * Cross-origin hosts must be listed in MIK_EMBED_ALLOWED_ORIGINS; same-origin
 * hosts are always accepted.
 *
 * 嵌入视图同样带有实时刷新控件，所以这里也提供共享探测器：一个页面仍然只有一个。
 */
export default async function EmbedLayout({ children }: { children: ReactNode }) {
  const { t } = await getI18n()
  const allowedOrigins = parseAllowedOrigins(process.env.MIK_EMBED_ALLOWED_ORIGINS)

  return (
    <EmbedShell allowedOrigins={allowedOrigins}>
      <main className="mx-auto w-full max-w-5xl px-4 pb-8 pt-4">
        <ConnectionProbeProvider>{children}</ConnectionProbeProvider>
        <p className="mt-8 border-t border-border pt-3 text-right text-[11px] text-subtle/85"> {t("s374")} <a className="underline" href="/"> {t("s375")} </a>
        </p>
      </main>
    </EmbedShell>
  )
}
