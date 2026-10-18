import { formatInt, formatPercent, formatUsd } from "../lib/format"

export function CacheSavings({ micros, label }: { micros?: number; label: string }) {
  return <div data-testid="overview-cache-savings" className="pb-5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-positive">
      <span data-testid="overview-cache-savings-micros">{formatInt(micros)} µUSD</span>
      <span className="mt-1 block text-xs font-normal text-subtle">{formatUsd(micros === undefined ? undefined : micros / 1_000_000)}</span>
    </dd>
  </div>
}

export function CacheHitBadge({ label }: { label: string }) {
  return <span data-testid="trace-cache-hit" className="inline-flex items-center rounded border border-positive/35 bg-positive/10 px-1.5 py-0.5 text-[11px] leading-4 text-positive">{label}</span>
}

/** label is the translated cache.approxHitBadge template, preserving its {0} slot. */
export function ApproxCacheHitBadge({ similarity, label }: { similarity?: string; label: string }) {
  const ratio = similarity?.trim() ? Number(similarity) : NaN
  const percent = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? formatPercent(ratio, 0) : "—"
  return <span data-testid="trace-approx-cache-hit" className="inline-flex items-center whitespace-nowrap rounded border border-positive/35 bg-positive/10 px-1.5 py-0.5 text-[11px] leading-4 text-positive">{label.replace("{0}", percent)}</span>
}

export function CacheStatus({ requestId, tokens, hit, miss, localHit, localHitLabel, approxHit, similarity, approxHitLabel }: { requestId: string; tokens: number; hit: string; miss: string; localHit?: boolean; localHitLabel?: string; approxHit?: boolean; similarity?: string; approxHitLabel?: string }) {
  return <li data-testid="trace-cache-status" className="text-xs text-subtle">
    <span className="font-mono">{requestId}</span> · {localHit && localHitLabel ? <CacheHitBadge label={localHitLabel} /> : approxHit ? hit : tokens > 0 ? hit : miss} {approxHit && approxHitLabel ? <ApproxCacheHitBadge similarity={similarity} label={approxHitLabel} /> : null} · {formatInt(tokens)} tokens
  </li>
}
