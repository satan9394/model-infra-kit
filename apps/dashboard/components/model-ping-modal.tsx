"use client"

import { useEffect, useRef, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { LATENCY_TONES, latencyLevel, type ModelPingResult } from "@/lib/model-capabilities"

export function ModelPingModal({ refName, onClose, onResult }: { refName: string; onClose: () => void; onResult: (result: ModelPingResult) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ModelPingResult | null>(null)
  const [error, setError] = useState("")
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const element = dialog.current
    if (element && !element.open) element.showModal()
    return () => { mounted.current = false; element?.close() }
  }, [])
  async function ping() {
    setBusy(true); setError(""); setResult(null)
    const response = await apiCall<ModelPingResult>(`/models/${encodeURIComponent(refName)}/ping`, { method: "POST" })
    if (!mounted.current) return
    setBusy(false)
    if (response.ok) { setResult(response.data); onResult(response.data) }
    else setError(response.error)
  }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="model-ping-title" className="m-auto w-[min(92vw,460px)] rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl backdrop:bg-black/50">
    <div className="flex items-start justify-between gap-3"><div><h2 id="model-ping-title" className="font-semibold">模型测速 / Model ping</h2><p className="mt-1 break-all font-mono text-xs text-subtle">{refName}</p></div><button aria-label="关闭 / Close" onClick={onClose} className="rounded p-1 focus-visible:outline-2 focus-visible:outline-primary">×</button></div>
    <p className="my-4 text-xs text-subtle">单次 Prompt: “ping” · 最多 4 输出 tokens。会产生少量实际计费 / One tiny billed request.</p>
    <button onClick={() => void ping()} disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm text-white dark:text-background disabled:opacity-50">{busy ? "测速中 / Testing…" : "开始测速 / Run ping"}</button>
    <div role="status" aria-live="polite" className="mt-4 text-sm" data-testid="model-ping-result">
      {error ? <p className="break-all text-danger">{error}</p> : null}
      {result ? <>
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
          <div><dt className="text-xs text-subtle">首字 / TTFT</dt><dd className={`mt-1 font-mono ${LATENCY_TONES[latencyLevel(result.firstTokenMs)]}`}>{result.firstTokenMs === null ? "未收到文本 / No text" : `${result.firstTokenMs} ms`}</dd></div>
          <div><dt className="text-xs text-subtle">总耗时 / Total</dt><dd className={`mt-1 font-mono ${LATENCY_TONES[latencyLevel(result.latencyMs)]}`}>{result.latencyMs} ms</dd></div>
          <div><dt className="text-xs text-subtle">输出速率 / Text tokens/s</dt><dd className="mt-1 font-mono">{result.tokensPerSecond?.toFixed(1) ?? "—"}</dd></div>
          <div><dt className="text-xs text-subtle">DNS 预查询 / Preflight</dt><dd className="mt-1 text-xs">{result.dnsMs === null ? "未提供 / Unavailable" : `${result.dnsMs} ms`}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-subtle">≤500 ms · 快 / Fast · ≤1500 ms · 正常 / Normal · ≤3000 ms · 慢 / Slow · &gt;3000 ms · 很慢 / Very slow</p>
        <details className="mt-3 text-xs"><summary className="cursor-pointer">请求详情 / Request details</summary><p className="mt-2 break-all">Prompt: {result.prompt} · Completion: {result.outputTokens} · Reasoning: {result.reasoningTokens} · {result.dnsNote}</p><pre className="mt-2 whitespace-pre-wrap break-all rounded bg-surface-muted p-2">{result.text}</pre></details>
      </> : null}
    </div>
  </dialog>
}
