"use client"

import { useI18n } from "@/lib/i18n/provider"

import { useEffect, useRef, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { LATENCY_TONES, latencyLevel, type ModelPingResult } from "@/lib/model-capabilities"

export function ModelPingModal({ refName, onClose, onResult }: { refName: string; onClose: () => void; onResult: (result: ModelPingResult) => void }) {
  const { t } = useI18n()

  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ModelPingResult | null>(null)
  const [error, setError] = useState("")
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    if (element && !element.open) element.showModal()
    return () => { mounted.current = false; element?.close(); trigger?.focus() }
  }, [])
  async function ping() {
    setBusy(true); setError(""); setResult(null)
    const response = await apiCall<ModelPingResult>(`/models/${encodeURIComponent(refName)}/ping`, { method: "POST" })
    if (!mounted.current) return
    setBusy(false)
    if (response.ok) { setResult(response.data); onResult(response.data) }
    else setError(response.error)
  }
  return <dialog role="dialog" aria-modal="true" ref={dialog} onCancel={onClose} aria-labelledby="model-ping-title" className="m-auto w-[min(92vw,460px)] rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl backdrop:bg-black/50">
    <div className="flex items-start justify-between gap-3"><div><h2 id="model-ping-title" className="font-semibold"> {t("s112")} </h2><p className="mt-1 break-all font-mono text-xs text-subtle">{refName}</p></div><button aria-label={t("s113")} onClick={onClose} className="rounded p-1 focus-visible:outline-2 focus-visible:outline-primary">×</button></div>
    <p className="my-4 text-xs text-subtle"> {t("s114")} </p>
    <button onClick={() => void ping()} disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm text-white dark:text-background disabled:opacity-50">{busy ? t("s115") : t("s116")}</button>
    <div role="status" aria-live="polite" className="mt-4 text-sm" data-testid="model-ping-result">
      {error ? <p className="break-all text-danger">{t(error)}</p> : null}
      {result ? <>
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
          <div><dt className="text-xs text-subtle"> {t("s117")} </dt><dd className={`mt-1 font-mono ${LATENCY_TONES[latencyLevel(result.firstTokenMs)]}`}>{result.firstTokenMs === null ? t("s118") : `${result.firstTokenMs} ms`}</dd></div>
          <div><dt className="text-xs text-subtle"> {t("s119")} </dt><dd className={`mt-1 font-mono ${LATENCY_TONES[latencyLevel(result.latencyMs)]}`}>{result.latencyMs} ms</dd></div>
          <div><dt className="text-xs text-subtle"> {t("s120")} </dt><dd className="mt-1 font-mono">{result.tokensPerSecond?.toFixed(1) ?? "—"}</dd></div>
          <div><dt className="text-xs text-subtle"> {t("s121")} </dt><dd className="mt-1 text-xs">{result.dnsMs === null ? t("s122") : `${result.dnsMs} ms`}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-subtle"> {t("s123")} </p>
        <details className="mt-3 text-xs"><summary className="cursor-pointer"> {t("s124")} </summary><p className="mt-2 break-all">Prompt: {result.prompt} · Completion: {result.outputTokens} · Reasoning: {result.reasoningTokens} · {result.dnsNote}</p><pre className="mt-2 whitespace-pre-wrap break-all rounded bg-surface-muted p-2">{result.text}</pre></details>
      </> : null}
    </div>
  </dialog>
}
