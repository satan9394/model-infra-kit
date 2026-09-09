"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const LINKS: ReadonlyArray<{ href: string; label: string; hint: string }> = [
  { href: "/", label: "概览", hint: "成本 / 请求 / token" },
  { href: "/trends", label: "趋势", hint: "按天堆叠与成本" },
  { href: "/providers", label: "供应商", hint: "连接与模型" },
  { href: "/models", label: "模型目录", hint: "能力与价格" },
  { href: "/pricing", label: "价格表", hint: "手动价与同步" },
  { href: "/logs", label: "请求日志", hint: "分页与详情" },
]

export function Nav() {
  const pathname = usePathname()
  return (
    <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-[#070b16]/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-wide text-slate-100">mik</span>
          <span className="text-xs text-slate-500">用量看板</span>
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
                    ? "rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-100"
                    : "rounded-md px-3 py-1.5 text-sm text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-200"
                }
              >
                {link.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
