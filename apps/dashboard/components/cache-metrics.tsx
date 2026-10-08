import { formatInt, formatUsd } from "../lib/format"

export function CacheSavings({ micros, label }: { micros?: number; label: string }) {
  return <div data-testid="overview-cache-savings" className="pb-5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-positive">{formatUsd(micros === undefined ? undefined : micros / 1_000_000)}</dd>
  </div>
}

export function CacheStatus({ requestId, tokens, hit, miss }: { requestId: string; tokens: number; hit: string; miss: string }) {
  return <li data-testid="trace-cache-status" className="text-xs text-subtle">
    <span className="font-mono">{requestId}</span> · {tokens > 0 ? hit : miss} · {formatInt(tokens)} tokens
  </li>
}
