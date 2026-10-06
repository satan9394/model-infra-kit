"use client"

import { useI18n } from "@/lib/i18n/provider"

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
import { apiCall } from "@/lib/client-api"
import { providerProbeError, providerStatusText } from "@/lib/provider-status"
import type { ProviderStatus } from "@/lib/types"
import { getProviderBrand } from "@/lib/provider-brands"

const inputClass =
  "mt-1 w-full rounded-md border border-border bg-surface-control px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"

export function AddProviderModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (payload: ProviderCreatePayload, defaultModelId?: string) => Promise<string | null>
}) {
  const { t } = useI18n()

  const dialogRef = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyProviderDraft())
  const [selectedPreset, setSelectedPreset] = useState<ProviderPresetId>("custom")
  const [presetSearch, setPresetSearch] = useState("")
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [probeStatus, setProbeStatus] = useState<ProviderStatus | null>(null)
  const [models, setModels] = useState<{ modelId: string }[]>([])
  const [defaultModelId, setDefaultModelId] = useState("")
  const probeController = useRef<AbortController | null>(null)
  const cancelProbe = () => { probeController.current?.abort(); probeController.current = null }
  const close = () => { cancelProbe(); onClose() }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    // Auto-focus the provider ID input
    const input = document.getElementById("provider-id")
    if (input) input.focus()
    return () => {
      cancelProbe()
      if (dialog.open) dialog.close()
      trigger?.focus()
    }
  }, [])

  const selectPreset = (presetId: ProviderPresetId) => {
    cancelProbe()
    setProbing(false); setModels([]); setDefaultModelId(""); setProbeStatus(null); setProbeError(null)
    setSelectedPreset(presetId)
    setDraft(draftFromPreset(presetId))
    setError(null)
  }

  const updateDraft = (patch: Partial<ProviderDraft>) => {
    if (patch.baseUrl !== undefined || patch.apiKeyRef !== undefined || patch.protocol !== undefined) {
      cancelProbe()
      setProbing(false); setModels([]); setDefaultModelId(""); setProbeStatus(null); setProbeError(null)
    }
    setDraft((current) => ({ ...current, ...patch }))
    setSelectedPreset("custom")
  }

  const probe = async () => {
    cancelProbe()
    const controller = new AbortController()
    probeController.current = controller
    setProbing(true); setProbeError(null); setProbeStatus(null); setModels([]); setDefaultModelId("")
    const timer = window.setTimeout(() => controller.abort(), 5000)
    try {
      const result = await apiCall<{ status: ProviderStatus & { errorCode?: string }; models: { modelId: string }[]; baseUrl?: string }>("/providers/probe", {
        method: "POST", signal: controller.signal,
        body: { protocol: draft.protocol, ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}), ...(draft.apiKeyRef.trim() ? { apiKeyRef: draft.apiKeyRef.trim() } : {}) },
      })
      if (probeController.current !== controller) return
      if (controller.signal.aborted) { setProbeError(t("provider.probeTimeout")); return }
      if (!result.ok) { setProbeError(providerProbeError({ message: result.error }, t)); return }
      setProbeStatus(result.data.status)
      if (result.data.status.ok) {
        setModels(result.data.models)
        const baseUrl = result.data.baseUrl
        if (baseUrl) setDraft((current) => ({ ...current, baseUrl }))
      } else setProbeError(providerProbeError(result.data.status, t))
    } finally {
      window.clearTimeout(timer)
      if (probeController.current === controller) { probeController.current = null; setProbing(false) }
    }
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
      cancelProbe()
      setProbing(false)
      const err = await onCreate(parsed.value, defaultModelId || undefined)
      if (err) setError(err)
      else close()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog role="dialog" aria-modal="true"
      ref={dialogRef}
      aria-labelledby="add-provider-title"
      className="m-auto max-h-[min(92vh,52rem)] w-[min(100%-2rem,46rem)] overflow-y-auto rounded-2xl border border-border bg-surface p-0 text-foreground shadow-2xl backdrop:bg-slate-950/60 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) close()
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary-soft text-xs font-semibold text-primary">
                +
              </span>
              <h2 id="add-provider-title" className="text-lg font-semibold tracking-tight text-foreground"> {t("s0")} </h2>
            </div>
            <p className="mt-1 text-xs text-subtle"> {t("s1")} </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={saving}
            aria-label={t("s2")}
            className="rounded-lg p-1.5 text-lg leading-none text-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          >
            ×
          </button>
        </header>

        <div className="space-y-5 px-6 py-5">
          {/* Preset Selector */}
          <fieldset>
            <legend className="mb-2.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span> {t("s3")} </span>
              <span className="text-[11px] font-normal text-subtle"> {t("s4")} </span>
            </legend>
            <label className="block">
              <span className="sr-only">{t("provider.searchPresets")}</span>
              <input type="search" className={inputClass} value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder={t("provider.searchPresets")} />
            </label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PROVIDER_PRESETS.filter((preset) => `${t(preset.label)} ${t(preset.hint)} ${preset.id}`.toLowerCase().includes(presetSearch.trim().toLowerCase())).map((preset) => {
                const selected = selectedPreset === preset.id
                const brand = getProviderBrand(preset.providerId || preset.id)
                return <button key={preset.id} type="button" aria-pressed={selected} onClick={() => selectPreset(preset.id)} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground hover:bg-surface-hover"}`}>
                  <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: brand.color }} />{t(preset.label)}
                </button>
              })}
            </div>
          </fieldset>

          {/* Core Configuration Fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="provider-id" className="text-xs font-medium text-muted-foreground">
              {t("s46")} <span className="text-danger">*</span>
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
              <span id="provider-id-help" className="mt-1 block text-[10px] font-normal text-subtle"> {t("s5")} </span>
            </label>

            <label className="text-xs font-medium text-muted-foreground"> {t("s6")} <input
                className={inputClass}
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder={t("s7")}
                autoComplete="off"
              />
              <span className="mt-1 block text-[10px] font-normal text-subtle"> {t("s8")} </span>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-muted-foreground"> {t("s9")} <select
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
              <span className="mt-1 block text-[10px] font-normal text-subtle"> {t("s10")} </span>
            </label>

            <label className="text-xs font-medium text-muted-foreground"> {t("s11")} <input
                className={`${inputClass} font-mono text-xs`}
                value={draft.apiKeyRef}
                onChange={(event) => updateDraft({ apiKeyRef: event.target.value })}
                placeholder="env:OPENAI_API_KEY"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="mt-1 block text-[10px] font-normal text-subtle">
                <code>env:NAME</code> {t("s12")} <code>file:path</code> {t("s13")} </span>
            </label>
          </div>

          <label className="block text-xs font-medium text-muted-foreground">
            {t("provider.baseUrl")}
            <input
              className={`${inputClass} font-mono text-xs`}
              value={draft.baseUrl}
              onChange={(event) => updateDraft({ baseUrl: event.target.value })}
              placeholder="https://api.openai.com/v1"
              autoComplete="url"
              spellCheck={false}
            />
            <span className="mt-1 block text-[10px] font-normal text-subtle"> {t("s14")} </span>
          </label>

          <section aria-label={t("provider.probe")} className="space-y-2" data-testid="provider-probe">
            <button type="button" onClick={() => void probe()} disabled={probing || saving} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
              {probing ? <span aria-hidden="true" className="size-3 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" /> : <span aria-hidden="true">↓</span>}
              {t(probing ? "provider.probing" : "provider.probe")}
            </button>
            <div aria-live="polite" role="status" className="text-xs">
              {probeError ? <p className="break-all text-danger" role="alert">{t(probeError)}</p> : probeStatus ? <p className="text-success">{providerStatusText(probeStatus, t)}</p> : null}
            </div>
            {models.length ? <>
              <p className="text-xs text-subtle">{t("provider.chooseDefault")}</p>
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {models.slice(0, 50).map((model) => <button type="button" key={model.modelId} aria-pressed={defaultModelId === model.modelId} onClick={() => setDefaultModelId(model.modelId)} className={`max-w-full break-all rounded-full border px-2.5 py-1 text-xs focus-visible:ring-2 focus-visible:ring-primary ${defaultModelId === model.modelId ? "border-primary bg-primary-soft text-primary" : "border-border hover:bg-surface-hover"}`}>{model.modelId}</button>)}
              </div>
              {models.length > 50 ? <p className="text-xs text-subtle">{t("provider.modelsLimited", models.length)}</p> : null}
              {defaultModelId ? <p className="break-all text-xs text-primary">{t("s257")}{defaultModelId}</p> : null}
            </> : null}
          </section>

          {/* Enabled Switch */}
          <label className="flex items-center gap-3 rounded-xl border border-border bg-surface-muted/50 p-3 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => updateDraft({ enabled: event.target.checked })}
              className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
            <div>
              <span className="block font-semibold text-foreground"> {t("s15")} </span>
              <span className="mt-0.5 block text-[11px] text-subtle"> {t("s16")} </span>
            </div>
          </label>

          {/* Advanced Headers */}
          <details className="rounded-xl border border-border bg-surface-muted/30">
            <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"> {t("s17")} </summary>
            <div className="border-t border-border p-4">
              <label htmlFor="provider-headers" className="text-xs font-medium text-muted-foreground">
                {t("provider.headers")}
              </label>
              <textarea
                id="provider-headers"
                className={`${inputClass} min-h-20 resize-y font-mono text-xs`}
                value={draft.headersJson}
                onChange={(event) => updateDraft({ headersJson: event.target.value })}
                spellCheck={false}
                placeholder='{ "HTTP-Referer": "https://example.com" }'
              />
              <p className="mt-1.5 text-[11px] text-subtle"> {t("s18")} <code>{"{}"}</code>。
              </p>
            </div>
          </details>

          {error ? (
            <p role="alert" className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-2.5 text-xs font-medium text-danger">
              {t(error)}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-muted/60 px-6 py-4">
          <p className="text-[11px] text-subtle"> {t("s19")} </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={close}
              disabled={saving}
              className="rounded-lg border border-border-strong px-4 py-2 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"
            > {t("s20")} </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg border border-primary bg-primary px-4 py-2 text-xs font-semibold text-surface shadow-xs hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? t("s21") : t("s22")}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  )
}
