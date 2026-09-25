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
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
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
    <section className={`rounded-xl border border-border/80 bg-surface shadow-sm ${className}`}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-subtle">{subtitle}</p> : null}
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
  neutral: "border-border-strong bg-surface-hover text-foreground/80",
  ok: "border-positive/35 bg-positive/10 text-positive",
  warn: "border-warning/35 bg-warning/10 text-warning",
  bad: "border-danger/35 bg-danger/10 text-danger",
  info: "border-info/40 bg-info/10 text-info",
  muted: "border-border bg-surface-muted text-subtle",
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
    neutral: "text-foreground",
    ok: "text-positive",
    warn: "text-warning",
    bad: "text-danger",
    info: "text-info",
    muted: "text-muted-foreground",
  }
  return (
    <div className="rounded-xl border border-border/80 bg-surface px-4 py-4 shadow-sm">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-xl font-semibold tracking-tight tabular-nums ${accent[tone]}`} data-testid={testId}>{value}</div>
      {hint ? <div className="mt-1 text-[11px] leading-5 text-subtle">{hint}</div> : null}
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
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-muted px-6 py-10 text-center">
      <p className="text-sm font-medium text-foreground/80">{title}</p>
      {description ? <p className="mt-1 max-w-md text-xs leading-5 text-subtle">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

export function ErrorBanner({ message, hint }: { message: string; hint?: ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-danger/35 bg-danger/10 px-4 py-3">
      <p className="text-sm font-medium text-danger">上游 mik serve 不可用</p>
      <p className="mt-1 break-all font-mono text-xs text-danger/80">{message}</p>
      {hint ? <div className="mt-2 text-xs text-danger/80">{hint}</div> : null}
    </div>
  )
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="dashboard-table w-full min-w-full border-collapse text-sm">{children}</table>
    </div>
  )
}

export function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`whitespace-nowrap border-b border-border/70 px-3 py-2 text-left text-xs font-medium text-subtle ${className}`}
    >
      {children}
    </th>
  )
}

export function Td({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-border/70 px-3 py-2 align-top text-foreground/80 ${className}`}>{children}</td>
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-1.5 last:border-b-0">
      <span className="shrink-0 text-xs text-subtle">{label}</span>
      <span className="break-all text-right font-mono text-xs text-foreground/80">{children}</span>
    </div>
  )
}

export function CardGrid({ children, cols = 3 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const map = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" } as const
  return <div className={`grid grid-cols-1 gap-3 ${map[cols]}`}>{children}</div>
}
