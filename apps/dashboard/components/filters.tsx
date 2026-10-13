"use client"

import { useI18n } from "@/lib/i18n/provider"

import { usePathname, useRouter } from "next/navigation"
import { useState, type ChangeEvent } from "react"
import { RANGE_PRESETS, readFilters, preserveFiltersQuery, withRange, type RangePreset, type ResolvedRange, type SearchParams } from "@/lib/range"
import type { ModelInfo, ProviderRecord } from "@/lib/types"

/** Preset window links plus a custom from/to form, all in the URL. */
export function RangePicker({ range, params }: { range: ResolvedRange; params: SearchParams }) {
  const { t } = useI18n()

  const router = useRouter()
  const [from, setFrom] = useState(range.fromInput)
  const [to, setTo] = useState(range.toInput)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="range-presets" role="group" aria-label={t("s57")}>
        {RANGE_PRESETS.filter((preset) => preset.value !== "custom").map((preset) => (
          <button
            key={preset.value}
            type="button"
            aria-pressed={range.preset === preset.value}
            onClick={() => router.push(withRange(params, { range: preset.value as RangePreset }))}
            className={
              range.preset === preset.value
                ? "range-preset range-preset-active"
                : "range-preset"
            }
          >
            {t(preset.label)}
          </button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          router.push(withRange(params, { range: "custom", from, to }))
        }}
      >
        <input
          type="date"
          aria-label={t("s58")}
          value={from}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setFrom(event.target.value)}
          className="filter-control"
        />
        <span className="text-xs text-subtle/85">~</span>
        <input
          type="date"
          aria-label={t("s59")}
          value={to}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setTo(event.target.value)}
          className="filter-control"
        />
        <button
          type="submit"
          className="filter-action"
        > {t("s60")} </button>
      </form>
      <span className="text-xs text-subtle"> {t("s61")} {t(range.label)}</span>
    </div>
  )
}

/** Provider / model / status filters. Provider first, model list follows it. */
export function FilterBar({
  providers,
  models,
  params,
  status = true,
}: {
  providers: ProviderRecord[]
  models: ModelInfo[]
  params: SearchParams
  status?: boolean
}) {
  const { t } = useI18n()

  const router = useRouter()
  const pathname = usePathname()
  const filters = readFilters(params)
  const currentProvider = filters.provider ?? ""
  const currentModel = filters.model ?? ""
  const currentStatus = filters.status ?? ""

  const push = (patch: Record<string, string>) => {
    router.push(`${pathname}${preserveFiltersQuery(params, patch)}`)
  }

  const providerIds = new Set(providers.map((provider) => provider.id))
  const visibleModels = currentProvider
    ? models.filter((model) => model.providerId === currentProvider)
    : models.filter((model) => providerIds.size === 0 || providerIds.has(model.providerId))

  const selectClass =
    "filter-control filter-select"

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={t("s62")} value={currentProvider} onChange={(event) => push({ provider: event.target.value, model: "" })} className={selectClass}>
        <option value=""> {t("s63")} </option>
        {currentProvider && !providerIds.has(currentProvider) ? <option value={currentProvider}>{currentProvider}</option> : null}
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name || provider.id}
          </option>
        ))}
      </select>
      <select aria-label={t("s64")} value={currentModel} onChange={(event) => push({ model: event.target.value })} className={selectClass}>
        <option value=""> {t("s65")} </option>
        {currentModel && !visibleModels.some((model) => model.modelId === currentModel) ? <option value={currentModel}>{currentModel}</option> : null}
        {visibleModels.map((model) => (
          <option key={model.ref} value={model.modelId}>
            {model.modelId}
          </option>
        ))}
      </select>
      {status ? (
        <select aria-label={t("s66")} value={currentStatus} onChange={(event) => push({ status: event.target.value })} className={selectClass}>
          <option value=""> {t("s67")} </option>
          <option value="ok"> {t("s68")} </option>
          <option value="error"> {t("s69")} </option>
        </select>
      ) : null}
      {Object.values(params).some((value) => Array.isArray(value) ? value.some(Boolean) : Boolean(value)) ? (
        <button
          type="button"
          data-testid="filters-reset"
          onClick={() => router.push(pathname)}
          className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-surface-muted hover:text-foreground"
        > {t("s70")} </button>
      ) : null}
    </div>
  )
}
