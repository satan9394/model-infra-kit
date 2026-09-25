"use client"

import { useRouter } from "next/navigation"
import { useState, type ChangeEvent } from "react"
import { RANGE_PRESETS, withRange, type RangePreset, type ResolvedRange, type SearchParams } from "@/lib/range"
import type { ModelInfo, ProviderRecord } from "@/lib/types"

/** Preset window links plus a custom from/to form, all in the URL. */
export function RangePicker({ range, params }: { range: ResolvedRange; params: SearchParams }) {
  const router = useRouter()
  const [from, setFrom] = useState(range.fromInput)
  const [to, setTo] = useState(range.toInput)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex overflow-hidden rounded-md border border-border">
        {RANGE_PRESETS.filter((preset) => preset.value !== "custom").map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => router.push(withRange(params, { range: preset.value as RangePreset }))}
            className={
              range.preset === preset.value
                ? "bg-surface-active px-3 py-1.5 text-xs font-medium text-foreground"
                : "px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            }
          >
            {preset.label}
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
          value={from}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setFrom(event.target.value)}
          className="rounded-md border border-border bg-surface-control px-2 py-1.5 text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        />
        <span className="text-xs text-subtle/85">~</span>
        <input
          type="date"
          value={to}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setTo(event.target.value)}
          className="rounded-md border border-border bg-surface-control px-2 py-1.5 text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        />
        <button
          type="submit"
          className="rounded-md border border-border-strong bg-surface-muted px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          应用
        </button>
      </form>
      <span className="text-xs text-subtle">当前：{range.label}</span>
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
  const router = useRouter()
  const currentProvider = typeof params.provider === "string" ? params.provider : ""
  const currentModel = typeof params.model === "string" ? params.model : ""
  const currentStatus = typeof params.status === "string" ? params.status : ""

  const push = (patch: Record<string, string>) => {
    const search = new URLSearchParams()
    for (const key of ["range", "from", "to", "provider", "model", "status", "limit"]) {
      const value = typeof params[key] === "string" ? (params[key] as string) : undefined
      if (value) search.set(key, value)
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value) search.set(key, value)
      else search.delete(key)
    }
    // Any filter change invalidates the page number.
    search.delete("offset")
    const query = search.toString()
    router.push(query ? `?${query}` : "?")
  }

  const providerIds = new Set(providers.map((provider) => provider.id))
  const visibleModels = currentProvider
    ? models.filter((model) => model.providerId === currentProvider)
    : models.filter((model) => providerIds.size === 0 || providerIds.has(model.providerId))

  const selectClass =
    "rounded-md border border-border bg-surface-control px-2 py-1.5 text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={currentProvider} onChange={(event) => push({ provider: event.target.value, model: "" })} className={selectClass}>
        <option value="">全部供应商</option>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name || provider.id}
          </option>
        ))}
      </select>
      <select value={currentModel} onChange={(event) => push({ model: event.target.value })} className={selectClass}>
        <option value="">全部模型</option>
        {visibleModels.map((model) => (
          <option key={model.ref} value={model.modelId}>
            {model.modelId}
          </option>
        ))}
      </select>
      {status ? (
        <select value={currentStatus} onChange={(event) => push({ status: event.target.value })} className={selectClass}>
          <option value="">全部状态</option>
          <option value="ok">成功</option>
          <option value="error">失败</option>
        </select>
      ) : null}
      {currentProvider || currentModel || currentStatus ? (
        <button
          type="button"
          onClick={() => push({ provider: "", model: "", status: "" })}
          className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-surface-muted hover:text-foreground"
        >
          清除过滤
        </button>
      ) : null}
    </div>
  )
}
