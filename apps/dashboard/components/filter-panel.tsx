"use client"

import { useI18n } from "@/lib/i18n/provider"
import type { ReactNode } from "react"
import { FilterBar, RangePicker } from "@/components/filters"
import type { ModelInfo, ProviderRecord } from "@/lib/types"
import type { ResolvedRange, SearchParams } from "@/lib/range"

/** The window + filter controls shared by the overview, trends and logs pages. */
export function FilterPanel({
  range,
  params,
  providers,
  models,
  status = true,
  extra,
}: {
  range: ResolvedRange
  params: SearchParams
  providers: ProviderRecord[]
  models: ModelInfo[]
  status?: boolean
  extra?: ReactNode
}) {
  const { t } = useI18n()

  return (
    <div className="filter-panel" role="region" aria-label={t("s56")}>
      <RangePicker key={`${range.fromInput}:${range.toInput}`} range={range} params={params} />
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
        <FilterBar providers={providers} models={models} params={params} status={status} />
        {extra}
      </div>
    </div>
  )
}
