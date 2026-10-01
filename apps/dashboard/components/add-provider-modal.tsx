"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import {
  buildCreateProviderPayload,
  draftFromPreset,
  emptyProviderDraft,
  PROVIDER_PRESETS,
  PROVIDER_PROTOCOLS,
  type ProviderCreatePayload,
  type ProviderDraft,
  type ProviderPresetId,
} from "@/lib/provider-presets"
import { getProviderBrand } from "@/lib/provider-brands"

const inputClass =
  "mt-1 w-full rounded-md border border-border bg-surface-control px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"

export function AddProviderModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (payload: ProviderCreatePayload) => Promise<string | null>
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyProviderDraft())
  const [selectedPreset, setSelectedPreset] = useState<ProviderPresetId>("custom")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    // Auto-focus the provider ID input
    const input = document.getElementById("provider-id")
    if (input) input.focus()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const selectPreset = (presetId: ProviderPresetId) => {
    setSelectedPreset(presetId)
    setDraft(draftFromPreset(presetId))
    setError(null)
  }

  const updateDraft = (patch: Partial<ProviderDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setSelectedPreset("custom")
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = buildCreateProviderPayload(draft)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }

    setSaving(true)
    setError(null)
    try {
      const err = await onCreate(parsed.value)
      if (err) setError(err)
      else onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="add-provider-title"
      className="m-auto max-h-[min(92vh,52rem)] w-[min(100%-2rem,46rem)] overflow-y-auto rounded-2xl border border-border bg-surface p-0 text-foreground shadow-2xl backdrop:bg-slate-950/60 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onClose()
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary-soft text-xs font-semibold text-primary">
                +
              </span>
              <h2 id="add-provider-title" className="text-lg font-semibold tracking-tight text-foreground">
                添加供应商
              </h2>
            </div>
            <p className="mt-1 text-xs text-subtle">
              从预设模板快速建立，或手动填写网关端点。密钥只保存环境引用，永不落库。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭添加窗口"
            className="rounded-lg p-1.5 text-lg leading-none text-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            ×
          </button>
        </header>

        <div className="space-y-5 px-6 py-5">
          {/* Preset Selector */}
          <fieldset>
            <legend className="mb-2.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>快速服务模板</span>
              <span className="text-[11px] font-normal text-subtle">点击即可自动预填端点与协议</span>
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
              {PROVIDER_PRESETS.map((preset) => {
                const selected = selectedPreset === preset.id
                const presetId = "presetId" in preset ? (preset as { presetId?: string }).presetId : undefined
                const brand = getProviderBrand(preset.providerId || preset.id, presetId)
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectPreset(preset.id)}
                    className={`group relative flex flex-col justify-between rounded-xl border p-2.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      selected
                        ? "border-primary bg-primary-soft shadow-sm"
                        : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className="inline-flex size-6 items-center justify-center rounded-md font-mono text-[10px] font-bold text-white shadow-xs"
                        style={{ backgroundColor: brand.color }}
                      >
                        {brand.shortTag}
                      </span>
                      {selected ? (
                        <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                      ) : null}
                    </div>
                    <div className="mt-2">
                      <span className={`block truncate text-xs font-semibold ${selected ? "text-primary" : "text-foreground"}`}>
                        {preset.label}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-subtle">
                        {preset.hint}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </fieldset>

          {/* Core Configuration Fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="provider-id" className="text-xs font-medium text-muted-foreground">
              Provider ID <span className="text-danger">*</span>
              <input
                id="provider-id"
                className={`${inputClass} font-mono text-xs`}
                value={draft.id}
                onChange={(event) => updateDraft({ id: event.target.value })}
                placeholder="my-gateway"
                autoComplete="off"
                maxLength={64}
                pattern="[a-zA-Z0-9_.-]+"
                aria-describedby="provider-id-help"
                required
              />
              <span id="provider-id-help" className="mt-1 block text-[10px] font-normal text-subtle">
                1–64 位字母、数字、点、下划线或短横线（创建后不可修改）。
              </span>
            </label>

            <label className="text-xs font-medium text-muted-foreground">
              显示名称
              <input
                className={inputClass}
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder="例如：Production OpenAI Gateway"
                autoComplete="off"
              />
              <span className="mt-1 block text-[10px] font-normal text-subtle">
                在监控看板与列表中展示的易读名称。
              </span>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-muted-foreground">
              协议
              <select
                className={inputClass}
                value={draft.protocol}
                onChange={(event) => updateDraft({ protocol: event.target.value })}
              >
                {PROVIDER_PROTOCOLS.map((protocol) => (
                  <option key={protocol} value={protocol}>
                    {protocol}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] font-normal text-subtle">
                决定下游适配器与模型目录发现方式。
              </span>
            </label>

            <label className="text-xs font-medium text-muted-foreground">
              API Key 引用
              <input
                className={`${inputClass} font-mono text-xs`}
                value={draft.apiKeyRef}
                onChange={(event) => updateDraft({ apiKeyRef: event.target.value })}
                placeholder="env:OPENAI_API_KEY"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="mt-1 block text-[10px] font-normal text-subtle">
                <code>env:NAME</code> 或 <code>file:path</code>，禁止填写密钥明文。
              </span>
            </label>
          </div>

          <label className="block text-xs font-medium text-muted-foreground">
            Base URL
            <input
              className={`${inputClass} font-mono text-xs`}
              value={draft.baseUrl}
              onChange={(event) => updateDraft({ baseUrl: event.target.value })}
              placeholder="https://api.openai.com/v1"
              autoComplete="url"
              spellCheck={false}
            />
            <span className="mt-1 block text-[10px] font-normal text-subtle">
              供应商 API 端点，留空则回落至协议默认官方端点。
            </span>
          </label>

          {/* Enabled Switch */}
          <label className="flex items-center gap-3 rounded-xl border border-border bg-surface-muted/50 p-3 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => updateDraft({ enabled: event.target.checked })}
              className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
            <div>
              <span className="block font-semibold text-foreground">创建后立即启用</span>
              <span className="mt-0.5 block text-[11px] text-subtle">
                启用后将立即参与模型的路由与用量采集；之后随时可暂停。
              </span>
            </div>
          </label>

          {/* Advanced Headers */}
          <details className="rounded-xl border border-border bg-surface-muted/30">
            <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              高级选项：自定义 HTTP 请求头（Headers JSON）
            </summary>
            <div className="border-t border-border p-4">
              <label htmlFor="provider-headers" className="text-xs font-medium text-muted-foreground">
                Headers（JSON）
              </label>
              <textarea
                id="provider-headers"
                className={`${inputClass} min-h-20 resize-y font-mono text-xs`}
                value={draft.headersJson}
                onChange={(event) => updateDraft({ headersJson: event.target.value })}
                spellCheck={false}
                placeholder='{ "HTTP-Referer": "https://example.com" }'
              />
              <p className="mt-1.5 text-[11px] text-subtle">
                输入键值对均为字符串的 JSON 对象；留空等同于 <code>{"{}"}</code>。
              </p>
            </div>
          </details>

          {error ? (
            <p role="alert" className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-2.5 text-xs font-medium text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-muted/60 px-6 py-4">
          <p className="text-[11px] text-subtle">
            数据将持久化至当前应用的 SQLite 数据库中。
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-border-strong px-4 py-2 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg border border-primary bg-primary px-4 py-2 text-xs font-semibold text-surface shadow-xs hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? "创建中…" : "创建供应商"}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  )
}
