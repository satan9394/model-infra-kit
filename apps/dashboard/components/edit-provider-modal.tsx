"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { buildProviderUpdatePayload, PROVIDER_PROTOCOLS, type ProviderDraft, type ProviderUpdatePayload } from "@/lib/provider-presets"
import type { ProviderRecord } from "@/lib/types"

const inputClass =
  "mt-1 w-full rounded-md border border-border bg-surface-control px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"

export function EditProviderModal({
  provider,
  onClose,
  onSave,
}: {
  provider: ProviderRecord
  onClose: () => void
  onSave: (payload: ProviderUpdatePayload) => Promise<string | null>
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<ProviderDraft>(() => ({
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol ?? "openai-compatible",
    baseUrl: provider.baseUrl ?? "",
    apiKeyRef: provider.apiKeyRef ?? "",
    headersJson: JSON.stringify(provider.headers ?? {}, null, 2),
    enabled: provider.enabled,
    presetId: provider.presetId,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const updateDraft = (patch: Partial<ProviderDraft>) => setDraft((current) => ({ ...current, ...patch }))

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = buildProviderUpdatePayload(draft)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }

    setSaving(true)
    setError(null)
    try {
      const saveError = await onSave(parsed.value)
      if (saveError) setError(saveError)
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
      aria-labelledby="edit-provider-title"
      className="m-auto max-h-[min(92vh,48rem)] w-[min(100%-2rem,42rem)] overflow-y-auto rounded-xl border border-border bg-surface p-0 text-foreground shadow-2xl backdrop:bg-slate-950/55"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onClose()
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 id="edit-provider-title" className="text-lg font-semibold tracking-tight">编辑供应商</h2>
            <p className="mt-1 text-xs text-subtle">更新连接配置；ID 保持不变，密钥只填写引用。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭编辑窗口"
            className="rounded-md px-2 py-1 text-lg leading-none text-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            ×
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-md border border-border bg-surface-muted px-3 py-2">
            <div className="text-[11px] font-medium text-subtle">供应商 ID</div>
            <code className="mt-1 block break-all font-mono text-sm text-foreground">{provider.id}</code>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-muted-foreground">
              显示名称
              <input
                className={inputClass}
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                autoComplete="off"
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              协议
              <select className={inputClass} value={draft.protocol} onChange={(event) => updateDraft({ protocol: event.target.value })}>
                {PROVIDER_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
              </select>
            </label>
          </div>

          <label className="block text-xs font-medium text-muted-foreground">
            Base URL
            <input
              className={`${inputClass} font-mono text-xs`}
              value={draft.baseUrl}
              onChange={(event) => updateDraft({ baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
              autoComplete="url"
              spellCheck={false}
            />
          </label>

          <label className="block text-xs font-medium text-muted-foreground">
            API Key 引用
            <input
              className={`${inputClass} font-mono text-xs`}
              value={draft.apiKeyRef}
              onChange={(event) => updateDraft({ apiKeyRef: event.target.value })}
              placeholder="env:OPENAI_API_KEY（留空可清除）"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="mt-1 block font-normal text-[11px] text-subtle">填写 <code>env:NAME</code> 或 <code>file:path</code> 引用，不要填写密钥明文。</span>
          </label>

          <label className="block text-xs font-medium text-muted-foreground">
            自定义 Headers（JSON）
            <textarea
              className={`${inputClass} min-h-24 resize-y font-mono text-xs`}
              value={draft.headersJson}
              onChange={(event) => updateDraft({ headersJson: event.target.value })}
              spellCheck={false}
              aria-describedby="provider-headers-help"
            />
            <span id="provider-headers-help" className="mt-1 block font-normal text-[11px] text-subtle">每个值都必须是字符串；留空等同于 <code>{"{}"}</code>。</span>
          </label>

          <label className="flex items-center gap-3 rounded-md border border-border px-3 py-3 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => updateDraft({ enabled: event.target.checked })}
              className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            />
            <span>
              <span className="block font-medium text-foreground">启用此供应商</span>
              <span className="mt-0.5 block text-xs text-subtle">停用后仍保留配置和历史用量。</span>
            </span>
          </label>

          {error ? <p role="alert" className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p> : null}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-muted/60 px-5 py-4">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-md border border-border-strong px-3 py-2 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-50">
            取消
          </button>
          <button type="submit" disabled={saving} className="rounded-md border border-primary bg-primary px-3 py-2 text-xs font-semibold text-surface hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
            {saving ? "保存中…" : "保存更改"}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
