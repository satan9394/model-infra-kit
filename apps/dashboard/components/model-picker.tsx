"use client"

import { useState } from "react"
import { useI18n } from "@/lib/i18n/provider"
import { filterModels, pickerModels, selectVisible, type PickerModel } from "@/lib/model-picker"

export function ModelPicker({ models, selected, defaultModelId, vendor, onChange, onDefault }: {
  models: readonly PickerModel[]
  selected: readonly string[]
  defaultModelId: string
  vendor: string
  onChange: (ids: string[]) => void
  onDefault: (id: string) => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const [onlySelected, setOnlySelected] = useState(false)
  const [saved] = useState(() => [...selected])
  const all = pickerModels(models, [...new Set([...saved, ...selected])])
  const visible = filterModels(all, selected, query, onlySelected)
  const fetched = new Set(models.map(model => model.modelId))
  const change = (ids: string[]) => {
    onChange(ids)
    if (!ids.includes(defaultModelId)) onDefault("")
  }
  const button = "rounded-md border border-border px-2.5 py-2 text-xs hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
  return <section data-testid="model-picker" aria-label={t("picker.title")} className="space-y-3 rounded-xl border border-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{t("picker.title")}</h3>
      <span role="status" className="rounded-full bg-primary-soft px-2 py-1 text-xs text-primary">{t("picker.count", selected.length, all.length)}</span>
    </div>
    <input type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label={t("picker.search")} placeholder={t("picker.search")} className="w-full rounded-md border border-border bg-surface-control px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary" />
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} disabled={!visible.length} onClick={() => change(selectVisible(selected, visible, true))}>{t("picker.all")}</button>
      <button type="button" className={button} disabled={!visible.length} onClick={() => change(selectVisible(selected, visible, false))}>{t("picker.none")}</button>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-4 accent-primary" checked={onlySelected} onChange={event => setOnlySelected(event.target.checked)} />{t("picker.onlySelected")}</label>
    </div>
    <div className="h-80 max-h-[45vh] overflow-y-auto overscroll-contain" tabIndex={0} aria-label={t("picker.title")}>
      {!visible.length ? <p className="py-8 text-center text-sm text-subtle">{t("picker.empty")}</p> : null}
      {[true, false].map(fromProvider => {
        const group = visible.filter(model => fetched.has(model.modelId) === fromProvider)
        return group.length ? <div key={String(fromProvider)} className="mb-3">
          <h4 className="sticky top-0 bg-surface py-2 text-xs font-medium text-subtle">{t(fromProvider ? "picker.fromProvider" : "picker.custom")}</h4>
          {group.map(model => <div key={model.modelId} className="flex items-center gap-2 border-b border-border py-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
              <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={selected.includes(model.modelId)} onChange={event => change(selectVisible(selected, [model], event.target.checked))} />
              <span className="min-w-0"><span className="block truncate font-mono" title={model.modelId}>{model.modelId}</span>
                <span className="flex flex-wrap gap-1 text-subtle">
                  <span>{model.vendor ?? vendor}</span>
                  {model.contextWindow ? <span>{t("picker.context", model.contextWindow)}</span> : null}
                  {model.capabilities?.image ? <span>{t("picker.vision")}</span> : null}
                  {model.capabilities?.reasoning ? <span>{t("picker.reasoning")}</span> : null}
                  {model.capabilities?.toolCall ? <span>{t("picker.tools")}</span> : null}
                </span>
              </span>
            </label>
            <button type="button" className={`${button} shrink-0 ${defaultModelId === model.modelId ? "border-primary text-primary" : ""}`} aria-pressed={defaultModelId === model.modelId} onClick={() => { onChange(selectVisible(selected, [model], true)); onDefault(model.modelId) }}>{t(defaultModelId === model.modelId ? "picker.default" : "picker.setDefault")}</button>
          </div>)}
        </div> : null
      })}
    </div>
  </section>
}
