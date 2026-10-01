"use client"

import { useI18n } from "@/lib/i18n/provider"

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
  const { t } = useI18n()

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
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      trigger?.focus()
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
    <dialog role="dialog" aria-modal="true"
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
            <h2 id="edit-provider-title" className="text-lg font-semibold tracking-tight"> {t("s43")} </h2>
            <p className="mt-1 text-xs text-subtle"> {t("s44")} </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label={t("s45")}
            className="rounded-md px-2 py-1 text-lg leading-none text-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            ×
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-md border border-border bg-surface-muted px-3 py-2">
            <div className="text-[11px] font-medium text-subtle"> {t("s46")} </div>
            <code className="mt-1 block break-all font-mono text-sm text-foreground">{provider.id}</code>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-muted-foreground"> {t("s6")} <input
                className={inputClass}
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                autoComplete="off"
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground"> {t("s9")} <select className={inputClass} value={draft.protocol} onChange={(event) => updateDraft({ protocol: event.target.value })}>
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

          <label className="block text-xs font-medium text-muted-foreground"> {t("s11")} <input
              className={`${inputClass} font-mono text-xs`}
              value={draft.apiKeyRef}
              onChange={(event) => updateDraft({ apiKeyRef: event.target.value })}
              placeholder={t("s47")}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="mt-1 block font-normal text-[11px] text-subtle"> {t("s48")} <code>env:NAME</code> {t("s12")} <code>file:path</code> {t("s49")} </span>
          </label>

          <label className="block text-xs font-medium text-muted-foreground"> {t("s50")} <textarea
              className={`${inputClass} min-h-24 resize-y font-mono text-xs`}
              value={draft.headersJson}
              onChange={(event) => updateDraft({ headersJson: event.target.value })}
              spellCheck={false}
              aria-describedby="provider-headers-help"
            />
            <span id="provider-headers-help" className="mt-1 block font-normal text-[11px] text-subtle"> {t("s51")} <code>{"{}"}</code>。</span>
          </label>

          <label className="flex items-center gap-3 rounded-md border border-border px-3 py-3 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => updateDraft({ enabled: event.target.checked })}
              className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            />
            <span>
              <span className="block font-medium text-foreground"> {t("s52")} </span>
              <span className="mt-0.5 block text-xs text-subtle"> {t("s53")} </span>
            </span>
          </label>

          {error ? <p role="alert" className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">{t(error)}</p> : null}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-muted/60 px-5 py-4">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-md border border-border-strong px-3 py-2 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"> {t("s20")} </button>
          <button type="submit" disabled={saving} className="rounded-md border border-primary bg-primary px-3 py-2 text-xs font-semibold text-surface hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
            {saving ? t("s54") : t("s55")}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
