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
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#0d1424] px-4 py-3">
      <RangePicker range={range} params={params} />
      <div className="flex flex-wrap items-center gap-3">
        <FilterBar providers={providers} models={models} params={params} status={status} />
        {extra}
      </div>
    </div>
  )
}
