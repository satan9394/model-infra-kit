"use client"
import { useState } from "react"
import { Card, EmptyState } from "@/components/ui"
import { PlaygroundDrawer } from "@/components/playground-drawer"
import { useI18n } from "@/lib/i18n/provider"
import { connectionSnippet, FRAMEWORKS, type Framework } from "@/lib/connect"

const LABELS: Record<Framework, string> = { ai: "Vercel AI SDK v7", "openai-node": "OpenAI Node / TypeScript", "openai-python": "OpenAI Python", langchain: "LangChain Python", curl: "cURL (POSIX shell)" }

export function ConnectGenerator({ baseUrl, models, defaultModel }: { baseUrl: string; models: { ref: string; displayName: string }[]; defaultModel?: string | null }) {
  const { t } = useI18n()
  const [framework, setFramework] = useState<Framework>("ai")
  const [model, setModel] = useState(models.find((item) => item.ref === defaultModel)?.ref ?? models[0]?.ref ?? "")
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  const [playground, setPlayground] = useState(false)
  if (!models.length) return <EmptyState title={t("connect.noModels")} />
  const snippet = connectionSnippet(framework, baseUrl, model)
  async function copy() {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setError("") }
    catch { setError(t("connect.copyFailed")) }
  }
  return <div className="space-y-5">
    <Card title={baseUrl} subtitle={t("connect.environment")}>
      <label className="block text-sm">{t("connect.model")}<select data-testid="connect-model" value={model} onChange={(event) => { setModel(event.target.value); setCopied(false) }} className="filter-control ml-3 max-w-full">{models.map((item) => <option key={item.ref} value={item.ref}>{item.displayName} · {item.ref}</option>)}</select></label>
      <div role="group" aria-label={t("connect.framework")} className="my-5 flex flex-wrap gap-2">{FRAMEWORKS.map((item) => <button type="button" key={item} aria-pressed={framework === item} onClick={() => { setFramework(item); setCopied(false) }} className={framework === item ? "filter-action bg-primary-soft text-primary" : "filter-action"}>{LABELS[item]}</button>)}</div>
      <pre data-testid="connect-snippet" tabIndex={0} aria-label={t("connect.snippet")} className="max-h-[480px] overflow-auto rounded-xl border border-border bg-surface-muted p-4 text-xs leading-6"><code>{snippet}</code></pre>
      <div className="mt-4 flex flex-wrap gap-3"><button type="button" onClick={() => void copy()} className="filter-action">{copied ? t("connect.copied") : t("connect.copy")}</button><button type="button" data-testid="playground-open" onClick={() => setPlayground(true)} className="filter-action">{t("connect.playground")}</button><span role="status" className="text-sm text-subtle">{error || (copied ? t("connect.copied") : "")}</span></div>
    </Card>
    {playground ? <PlaygroundDrawer models={models} initialModel={model} onClose={() => setPlayground(false)} /> : null}
  </div>
}
