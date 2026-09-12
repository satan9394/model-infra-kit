import type { ReactNode } from "react"

/**
 * Shared presentation primitives. No component library: a handful of small,
 * server-renderable pieces is all this dashboard needs.
 */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  padded = true,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <section className={`rounded-xl border border-slate-800 bg-[#0d1424] ${className}`}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3">
          <div>
            <h2 className="text-sm font-medium text-slate-200">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  )
}

type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "muted"

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-slate-700 bg-slate-800/60 text-slate-300",
  ok: "border-emerald-800/70 bg-emerald-950/60 text-emerald-300",
  warn: "border-amber-800/70 bg-amber-950/60 text-amber-300",
  bad: "border-rose-900/70 bg-rose-950/60 text-rose-300",
  info: "border-sky-900/70 bg-sky-950/60 text-sky-300",
  muted: "border-slate-800 bg-slate-900/60 text-slate-500",
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-4 ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  )
}

export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  testId,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
  /**
   * `data-testid` for the value element. The rendered-HTML checks
   * (`scripts/e2e/run.mjs`, DASH) anchor on it so an assertion about *this*
   * cell cannot be satisfied by the same string elsewhere on the page.
   */
  testId?: string
}) {
  const accent: Record<Tone, string> = {
    neutral: "text-slate-100",
    ok: "text-emerald-300",
    warn: "text-amber-300",
    bad: "text-rose-300",
    info: "text-sky-300",
    muted: "text-slate-400",
  }
  return (
    <div className="rounded-xl border border-slate-800 bg-[#0d1424] px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 font-mono text-xl tabular-nums ${accent[tone]}`} data-testid={testId}>{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-800 bg-slate-900/30 px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {description ? <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

export function ErrorBanner({ message, hint }: { message: string; hint?: ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-rose-900/70 bg-rose-950/40 px-4 py-3">
      <p className="text-sm font-medium text-rose-200">上游 mik serve 不可用</p>
      <p className="mt-1 break-all font-mono text-xs text-rose-300/90">{message}</p>
      {hint ? <div className="mt-2 text-xs text-rose-200/70">{hint}</div> : null}
    </div>
  )
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-full border-collapse text-sm">{children}</table>
    </div>
  )
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`whitespace-nowrap border-b border-slate-800 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500 ${className}`}
    >
      {children}
    </th>
  )
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-slate-800/60 px-3 py-2 align-top text-slate-300 ${className}`}>{children}</td>
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-800/60 py-1.5 last:border-b-0">
      <span className="shrink-0 text-xs text-slate-500">{label}</span>
      <span className="break-all text-right font-mono text-xs text-slate-300">{children}</span>
    </div>
  )
}

export function CardGrid({ children, cols = 3 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const map = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" } as const
  return <div className={`grid grid-cols-1 gap-3 ${map[cols]}`}>{children}</div>
}
