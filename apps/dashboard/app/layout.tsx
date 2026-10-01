import { getI18n } from "@/lib/i18n/server"
import { I18nProvider } from "@/lib/i18n/provider"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import Script from "next/script"
import { ThemeProvider } from "@/components/theme-provider"
import "./globals.css"

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n()
  return { title: t("s376"), description: t("s377") }
}

/**
 * 根布局只负责文档骨架。带导航的完整版在 `app/(main)/layout.tsx`，
 * 无导航的嵌入版在 `app/embed/layout.tsx`——两条 URL 树共用这里。
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { lang } = await getI18n()
  return (
    <html lang={lang === "zh" ? "zh-CN" : "en"} data-theme="system" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Script id="mik-theme-preference" strategy="beforeInteractive">
          {`(() => {
            const key = "mik-dashboard-theme";
            let preference = "system";
            try {
              const stored = window.localStorage.getItem(key);
              if (stored === "light" || stored === "dark" || stored === "system") preference = stored;
            } catch {}
            const root = document.documentElement;
            root.dataset.theme = preference;
            root.classList.toggle("dark", preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches));
          })();`}
        </Script>
        <I18nProvider initialLang={lang}><ThemeProvider>{children}</ThemeProvider></I18nProvider>
      </body>
    </html>
  )
}
