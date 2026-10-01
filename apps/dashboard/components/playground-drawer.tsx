"use client"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { useModalDialog } from "@/lib/use-modal-dialog"
import { useI18n } from "@/lib/i18n/provider"
import { apiCall } from "@/lib/client-api"
import { readPlaygroundStream, usdToMicros, type PlaygroundStreamResult } from "@/lib/playground"
import type { LogsPayload } from "@/lib/types"

export function PlaygroundDrawer({ models, initialModel, onClose }: { models: { ref: string; displayName: string }[]; initialModel: string; onClose: () => void }) {
  const { t } = useI18n()
  const router = useRouter()
  const dialog = useModalDialog()
  const controller = useRef<AbortController | null>(null)
  const [model, setModel] = useState(initialModel)
  const [prompt, setPrompt] = useState(t("playground.promptHi"))
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<PlaygroundStreamResult | null>(null)
  const [cost, setCost] = useState<number | null>(null)
  const [costStatus, setCostStatus] = useState("")
  useEffect(() => () => controller.current?.abort(), [])
  async function send(event: FormEvent) {
    event.preventDefault()
    if (busy || !prompt.trim()) return
    const abort = new AbortController()
    controller.current = abort
    const traceId = `playground-${crypto.randomUUID()}`
    setBusy(true); setText(""); setError(""); setResult(null); setCost(null); setCostStatus("")
    const start = performance.now()
    try {
      const response = await fetch("/api/playground", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt, traceId }), signal: abort.signal })
      const metrics = await readPlaygroundStream(response, setText, () => performance.now(), start)
      if (abort.signal.aborted) return
      setResult(metrics)
      const logs = await apiCall<LogsPayload>(`/usage/logs?traceId=${encodeURIComponent(traceId)}&limit=1`)
      if (abort.signal.aborted) return
      const recorded = logs.ok ? logs.data.events.find((item) => item.traceId === traceId) : undefined
      if (!recorded) setCostStatus(t("playground.noRecord"))
      else if (recorded.cost.source === "missing") setCostStatus(t("playground.unpriced"))
      else setCost(usdToMicros(recorded.cost.usd))
      router.refresh()
    } catch (failure) {
      if (abort.signal.aborted) setError(t("playground.stopped"))
      else setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (controller.current === abort) { controller.current = null; setBusy(false) } }
  }
  function close() { controller.current?.abort(); onClose() }
  return <dialog ref={dialog} role="dialog" aria-modal="true" aria-labelledby="playground-title" onCancel={close} className="ml-auto mr-0 h-full max-h-screen w-full max-w-2xl overflow-y-auto border-l border-border bg-surface p-6 text-foreground backdrop:bg-black/50">
    <div className="flex items-center justify-between"><h2 id="playground-title" className="text-xl font-semibold">{t("playground.title")}</h2><button type="button" aria-label={t("s77")} onClick={close} className="filter-action">×</button></div>
    <p className="my-4 text-sm text-subtle">{t("playground.warning")}</p>
    <form onSubmit={(event) => void send(event)} className="space-y-4">
      <label className="block text-sm">{t("connect.model")}<select value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} className="filter-control mt-1 w-full">{models.map((item) => <option key={item.ref} value={item.ref}>{item.displayName} · {item.ref}</option>)}</select></label>
      <div className="flex flex-wrap gap-2">{([ ["connectivity", "promptHi"], ["reasoning", "promptReason"], ["greeting", "promptGreeting"] ] as const).map(([label, key]) => <button type="button" key={key} disabled={busy} className="filter-action" onClick={() => setPrompt(t(`playground.${key}`))}>{t(`playground.${label}`)}</button>)}</div>
      <label className="block text-sm">{t("playground.prompt")}<textarea data-testid="playground-prompt" autoFocus value={prompt} disabled={busy} maxLength={8000} required onChange={(event) => setPrompt(event.target.value)} className="filter-control mt-1 min-h-24 w-full" /></label>
      <button type="submit" data-testid="playground-send" disabled={busy || !prompt.trim()} className="filter-action">{busy ? t("playground.sending") : t("playground.send")}</button>
      {busy ? <button type="button" onClick={() => controller.current?.abort()} className="filter-action ml-2">{t("playground.cancel")}</button> : null}
    </form>
    <section className="mt-6" aria-label={t("playground.response")}><pre data-testid="playground-response" aria-live="polite" className="min-h-24 whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-muted p-4 text-sm">{text || (busy ? t("playground.waiting") : "—")}</pre><p role="alert" className="mt-2 text-sm text-danger">{error}</p></section>
    {result ? <dl aria-label={t("playground.metrics")} className="mt-5 grid grid-cols-2 gap-4 text-sm">
      <div><dt>{t("s119")}</dt><dd>{result.durationMs} ms</dd></div><div><dt>TTFT</dt><dd data-testid="playground-ttft">{result.ttftMs === null ? "—" : `${result.ttftMs} ms`}</dd></div>
      <div><dt>Prompt / Completion / Reasoning</dt><dd>{result.input ?? "—"} / {result.output ?? "—"} / {result.reasoning ?? "—"}</dd></div>
      <div><dt>{t("playground.cost")}</dt><dd data-testid="playground-micros">{cost ?? (costStatus || "—")}</dd></div>
    </dl> : null}
  </dialog>
}
