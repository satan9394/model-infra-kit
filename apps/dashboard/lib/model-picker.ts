export interface PickerModel {
  modelId: string
  displayName?: string
  vendor?: string
  contextWindow?: number
  capabilities?: Partial<Record<"text" | "image" | "toolCall" | "reasoning" | "structuredOutput", boolean>>
}

export function selectedModelIds(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(id => typeof id === "string" && id.trim().length > 0)
    ? [...new Set(value as string[])] : undefined
}

export function pickerModels(models: readonly PickerModel[], selected: readonly string[]): PickerModel[] {
  const unique = new Map(models.map(model => [model.modelId, model]))
  for (const modelId of selected) if (!unique.has(modelId)) unique.set(modelId, { modelId })
  return [...unique.values()]
}

export function filterModels(models: readonly PickerModel[], selected: readonly string[], query: string, onlySelected: boolean): PickerModel[] {
  const needle = query.trim().toLowerCase()
  return models.filter(model => (!onlySelected || selected.includes(model.modelId))
    && `${model.modelId} ${model.displayName ?? ""} ${model.vendor ?? ""}`.toLowerCase().includes(needle))
}

export function selectVisible(selected: readonly string[], visible: readonly PickerModel[], checked: boolean): string[] {
  const visibleIds = new Set(visible.map(model => model.modelId))
  return checked ? [...new Set([...selected, ...visibleIds])] : selected.filter(id => !visibleIds.has(id))
}
