"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "@/components/theme-provider"
import type { ThemePreference } from "@/lib/theme"

const LINKS: ReadonlyArray<{ href: string; label: string; hint: string }> = [
  { href: "/", label: "概览", hint: "成本 / 请求 / token" },
  { href: "/trends", label: "趋势", hint: "按天堆叠与成本" },
  { href: "/traces", label: "Agent 任务", hint: "Session / Trace 成本链路" },
  { href: "/providers", label: "供应商", hint: "连接与模型" },
  { href: "/models", label: "模型目录", hint: "能力与价格" },
  { href: "/pricing", label: "价格表", hint: "手动价与同步" },
  { href: "/logs", label: "请求日志", hint: "分页与详情" },
]

export function Nav() {
  const pathname = usePathname()
  const { preference, setPreference } = useTheme()
  const themeOptions: ReadonlyArray<{ value: ThemePreference; icon: string; label: string }> = [
    { value: "light", icon: "☀️", label: "浅色" },
    { value: "dark", icon: "🌙", label: "深色" },
    { value: "system", icon: "💻", label: "跟随系统" },
  ]

  return (
    <header className="sticky top-0 z-20 border-b border-border/80 bg-background/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-wide text-foreground">mik</span>
          <span className="text-xs text-subtle">用量看板</span>
        </Link>
        <nav className="flex flex-wrap items-center gap-1">
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href)
            return (
              <Link
                key={link.href}
                href={link.href}
                title={link.hint}
                className={
                  active
                    ? "rounded-md bg-primary-soft px-3 py-1.5 text-sm font-medium text-primary"
                    : "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
                }
              >
                {link.label}
              </Link>
            )
          })}
        </nav>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-border bg-surface p-1" role="group" aria-label="颜色主题">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={`${option.label}主题`}
              aria-pressed={preference === option.value}
              title={option.label}
              onClick={() => setPreference(option.value)}
              className={
                preference === option.value
                  ? "inline-flex items-center gap-1 rounded-md bg-surface-active px-2 py-1.5 text-xs font-medium text-foreground shadow-sm"
                  : "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
              }
            >
              <span aria-hidden="true">{option.icon}</span>
              <span className="hidden sm:inline">{option.label}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
