"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { apiCall } from "@/lib/client-api"
import { useI18n } from "@/lib/i18n/provider"
import { quotaPercent, quotaRatePercent, type QuotaUsage, type QuotasPayload } from "@/lib/quotas"
import { Card } from "@/components/ui"

/**
 * EVO-G143: host-side quota configuration is not editable from this read-only
 * page, so the empty state shows the exact contract instead of a blank panel.
 * Field names mirror `TenantQuotaConfig` (`packages/mik/src/quota/rate-limiter.ts`).
 */
const QUOTA_SNIPPET = `createServer({
  quotas: {
    applications: [{
      appId: "default",
      maxRpm: 600,                 // requests per minute
      maxTpm: 120000,              // tokens per minute
      dailyHardCapMicros: 5_000_000n,     // 5 USD in microdollars
      monthlyHardCapMicros: 100_000_000n, // 100 USD in microdollars
    }],
  },
})`

export function QuotasPanel({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n()
  const [data, setData] = useState<QuotasPayload | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    let pending = false
    const controller = new AbortController()
    async function load() {
      if (pending) return
      pending = true
      const result = await apiCall<QuotasPayload>("/quotas", { signal: controller.signal })
      pending = false
      if (!active) return
      setError(!result.ok)
      setData(result.ok ? result.data : null)
    }
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    return () => { active = false; controller.abort(); clearInterval(timer) }
  }, [])

  function meter(label: string, text: string, value: number | null) {
    return <div className="min-w-0">
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs"><span className="text-subtle">{label}</span><span className="break-all font-mono tabular-nums">{text}</span></div>
      {value !== null ? <progress aria-label={label} max={100} value={value} className={`mt-2 h-1.5 w-full ${value >= 100 ? "accent-danger" : "accent-primary"}`} /> : null}
    </div>
  }
  function usage(value: QuotaUsage) {
    return <div className="mt-3 grid gap-4 sm:grid-cols-2">
      {meter(t("quotas.rpm"), `${value.currentRpm} / ${value.limitRpm ?? t("quotas.unlimited")}`, quotaRatePercent(value.currentRpm, value.limitRpm))}
      {meter(t("quotas.tpm"), `${value.currentTpm} / ${value.limitTpm ?? t("quotas.unlimited")}`, quotaRatePercent(value.currentTpm, value.limitTpm))}
      {meter(t("quotas.daily"), `${value.dailySpentMicros} / ${value.dailyHardCapMicros ?? t("quotas.unlimited")}`, quotaPercent(value.dailySpentMicros, value.dailyHardCapMicros))}
      {meter(t("quotas.monthly"), `${value.monthlySpentMicros} / ${value.monthlyHardCapMicros ?? t("quotas.unlimited")}`, quotaPercent(value.monthlySpentMicros, value.monthlyHardCapMicros))}
    </div>
  }
  return <div className="my-4" data-testid={compact ? "overview-quotas" : "tenant-quotas"}>
    <Card title={t("quotas.title")} subtitle={t("quotas.scope")} actions={compact ? <Link href="/quotas" className="text-xs text-primary underline">{t("quotas.details")}</Link> : undefined}>
      <div aria-live="polite">
        {error ? <p role="status" className="text-sm text-subtle">{t("quotas.unavailable")}</p> : !data ? <p className="text-sm text-subtle">{t("quotas.loading")}</p> : data.quotas.length === 0 ? <div data-testid="quota-guide" className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">{t("quotas.guideTitle")}</h3>
            <p className="mt-1 text-xs leading-5 text-subtle">{t("quotas.guideIntro")}</p>
          </div>
          <p className="text-xs font-medium text-muted-foreground">{t("quotas.guideSnippet")}</p>
          <pre data-testid="quota-guide-snippet" className="max-w-full overflow-x-auto rounded-xl border border-border bg-surface-muted p-4 text-xs leading-6"><code>{QUOTA_SNIPPET}</code></pre>
          <ul className="space-y-1 text-xs leading-5 text-subtle">
            <li>{t("quotas.guideRpm")}</li>
            <li>{t("quotas.guideTpm")}</li>
            <li>{t("quotas.guideDaily")}</li>
            <li>{t("quotas.guideMonthly")}</li>
          </ul>
          <p className="text-xs leading-5 text-subtle">{t("quotas.guideNote")}</p>
        </div> : <div className="space-y-5">
          {data.quotas.map((quota) => <article key={quota.appId} className="rounded-xl border border-border p-4" data-testid="quota-application">
            <h3 className="break-all text-sm font-medium">{t("quotas.application")} · {quota.appId}</h3>
            {usage(quota)}
            {!compact && quota.org ? <div className="mt-5 border-t border-border pt-4" data-testid="quota-organization">
              <h4 className="break-all text-xs font-medium">{t("quotas.organization")} · {quota.orgId}</h4>
              {usage(quota.org)}
            </div> : null}
          </article>)}
        </div>}
      </div>
      {!compact && data ? <div className="mt-6" data-testid="quota-block-logs">
        <h3 className="text-sm font-medium">{t("quotas.logs")}</h3>
        <p className="mt-1 text-xs text-subtle">{t("quotas.logsDetail")}</p>
        {data.logs.length === 0 ? <p className="mt-3 text-sm text-subtle">{t("quotas.noLogs")}</p> : <ul className="mt-3 divide-y divide-border">
          {data.logs.slice(0, 50).map((log) => <li key={log.requestId} className="grid gap-1 py-3 text-xs sm:grid-cols-2">
            <time dateTime={new Date(log.ts).toISOString()} className="font-mono">{new Date(log.ts).toISOString()}</time>
            <span className="break-all text-danger">{t(`quotas.${log.errorCode}`)}</span>
            <span className="break-all text-subtle">{log.appId}</span><Link href={`/logs?focusId=${encodeURIComponent(log.requestId)}`} title={t("quotas.openLog")} aria-label={t("quotas.openLog")} className="break-all text-info underline">{log.requestId}</Link>
          </li>)}
        </ul>}
      </div> : null}
    </Card>
  </div>
}
