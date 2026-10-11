import { formatInt, formatUsd } from "../lib/format"

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

export function CacheStatus({ requestId, tokens, hit, miss, localHit, localHitLabel }: { requestId: string; tokens: number; hit: string; miss: string; localHit?: boolean; localHitLabel?: string }) {
  return <li data-testid="trace-cache-status" className="text-xs text-subtle">
    <span className="font-mono">{requestId}</span> · {localHit && localHitLabel ? <CacheHitBadge label={localHitLabel} /> : tokens > 0 ? hit : miss} · {formatInt(tokens)} tokens
  </li>
}
