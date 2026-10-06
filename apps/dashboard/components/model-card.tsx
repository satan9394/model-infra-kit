"use client"

import { useI18n } from "@/lib/i18n/provider"

import { formatRate } from "@/lib/format"
import { CAPABILITY_FILTERS, matchesCapabilities, LATENCY_TONES, latencyLevel } from "@/lib/model-capabilities"
import type { ModelInfo } from "@/lib/types"
import { budgetMoney } from "@/lib/budget"

function compactContext(tokens?: number) {
  if (tokens === undefined) return "—"
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}
function perThousand(rate?: number) {
  if (rate === undefined) return "—"
  // Convert the rate once; scale the display using integer micro-USD.
  const micros = Number((BigInt(Math.round(rate * 1_000_000)) + 500n) / 1000n)
  return rate > 0 && micros === 0 ? "<$0.000001" : budgetMoney(micros)
}
const PROVIDER_TONES = ["border-primary/25 bg-primary-soft text-primary", "border-info/25 bg-info/10 text-info", "border-positive/25 bg-positive/10 text-positive", "border-warning/25 bg-warning/10 text-warning"] as const
const PATHS = { ping: "m13 2-9 12h7l-1 8 10-12h-7l1-8Z", copy: "M9 9h12v12H9z M3 15V3h12", default: "m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z" }

export function ModelCard({ model, providerName, firstTokenMs, isDefault, busy, onPing, onCopy, onDefault }: {
  model: ModelInfo; providerName: string; firstTokenMs?: number; isDefault: boolean; busy: boolean
  onPing: () => void; onCopy: () => void; onDefault: () => void
}) {
  const { t } = useI18n()

  const providerTone = PROVIDER_TONES[[...model.providerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % PROVIDER_TONES.length]
  return <article className="group min-w-0 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-primary/50" data-testid="model-card" data-model-ref={model.ref}>
    <div className="flex items-start justify-between gap-2">
      <span className={`rounded-md border px-2 py-1 text-[10px] ${providerTone}`} title={model.providerId}>{providerName}</span>
      <div className="model-actions flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {([ ["ping", t("s101"), onPing], ["copy", t("s102"), onCopy], ["default", isDefault ? t("s103") : t("s104"), onDefault] ] as const).map(([icon, label, action]) => <button key={icon} type="button" title={label} aria-label={`${label}: ${model.ref}`} aria-pressed={icon === "default" ? isDefault : undefined} onClick={action} disabled={busy} className={`rounded-md p-1.5 hover:bg-surface-active focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 ${icon === "default" && isDefault ? "text-warning" : "text-muted-foreground"}`}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d={PATHS[icon]} /></svg>
        </button>)}
      </div>
    </div>
    <h3 className="mt-4 break-all font-mono text-sm font-semibold">{model.modelId}</h3>
    <p className="mt-1 text-xs text-subtle">{model.displayName}</p>
    <div className="my-4 flex flex-wrap gap-1.5">{CAPABILITY_FILTERS.filter(({ key }) => matchesCapabilities(model, [key], firstTokenMs)).map(({ key, label }) => <span key={key} className="rounded-full bg-surface-muted px-2 py-1 text-[10px] text-muted-foreground">{t(label)}</span>)}</div>
    <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
      <div><dt className="text-subtle"> {t("s105")} </dt><dd className="mt-1 font-mono">{compactContext(model.contextWindow)}</dd></div>
      <div><dt className="text-subtle"> {t("s106")} </dt><dd className="mt-1 font-mono">{compactContext(model.maxOutputTokens)}</dd></div>
      <div><dt className="text-subtle"> {t("s107")} </dt><dd className="mt-1 font-mono">{perThousand(model.pricing?.inputPerM)}</dd></div>
      <div><dt className="text-subtle"> {t("s108")} </dt><dd className="mt-1 font-mono">{perThousand(model.pricing?.outputPerM)}</dd></div>
    </dl>
    <p className="mt-3 break-all text-[10px] text-subtle">{model.ref} · {t(`model.source.${model.source}`)} · {model.pricing?.source ? t(`price.source.${model.pricing.source}`) : t("s109")}</p>
    {model.pricing ? <p className="mt-1 text-[10px] text-subtle"> {t("s110")} {formatRate(model.pricing.cacheReadPerM)} / {formatRate(model.pricing.cacheWritePerM)}{model.pricing.contextTierAbove ? ` · ${t("price.contextTier", compactContext(model.pricing.contextTierAbove))}` : ""}{model.pricing.reasoningMode ? ` · ${t("price.reasoningTier")}` : ""}</p> : null}
    {firstTokenMs !== undefined ? <p className={`mt-2 font-mono text-xs ${LATENCY_TONES[latencyLevel(firstTokenMs)]}`}> {t("s111")} {firstTokenMs} ms</p> : null}
  </article>
}
