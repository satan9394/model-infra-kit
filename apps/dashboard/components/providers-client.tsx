"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { EditProviderModal } from "@/components/edit-provider-modal"
import { apiCall } from "@/lib/client-api"
import {
  buildCreateProviderPayload,
  draftFromPreset,
  emptyProviderDraft,
  PROVIDER_PRESETS,
  PROVIDER_PROTOCOLS,
  type ProviderDraft,
  type ProviderPresetId,
  type ProviderUpdatePayload,
} from "@/lib/provider-presets"
import { formatDateTime, formatMs } from "@/lib/format"
import type { ModelInfo, ProviderRecord, ProviderStatus } from "@/lib/types"
import { Badge, EmptyState } from "@/components/ui"

interface RowState {
  testing?: boolean
  refreshing?: boolean
  loadingModels?: boolean
  status?: ProviderStatus
  models?: ModelInfo[]
  error?: string
  open?: boolean
}

const inputClass =
  "mt-1 w-full rounded-md border border-border bg-surface-control px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"

const toolButtonClass =
  "inline-flex items-center justify-center rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-50"

export function ProvidersClient({ providers }: { providers: ProviderRecord[] }) {
  const router = useRouter()
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)
  const [form, setForm] = useState<ProviderDraft>(() => emptyProviderDraft())
  const [selectedPreset, setSelectedPreset] = useState<ProviderPresetId>("custom")
  const [editingProvider, setEditingProvider] = useState<ProviderRecord | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const patchRow = (id: string, patch: Partial<RowState>) =>
    setRows((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }))

  const updateForm = (patch: Partial<ProviderDraft>) => {
    setForm((current) => ({ ...current, ...patch }))
    setSelectedPreset("custom")
  }

  const test = async (id: string) => {
    patchRow(id, { testing: true, error: undefined })
    const result = await apiCall<{ status: ProviderStatus }>(`/providers/${encodeURIComponent(id)}/test`, { method: "POST" })
    patchRow(id, {
      testing: false,
      status: result.ok ? result.data.status : undefined,
      error: result.ok ? undefined : result.error,
    })
    if (result.ok) {
      setNotice({ tone: result.data.status.ok ? "ok" : "bad", text: `${id}：${result.data.status.message}` })
    } else {
      setNotice({ tone: "bad", text: `${id}：${result.error}` })
    }
  }

  const refreshModels = async (id: string) => {
    patchRow(id, { refreshing: true, error: undefined })
    const result = await apiCall<{ models: ModelInfo[] }>(`/providers/${encodeURIComponent(id)}/models/refresh`, { method: "POST" })
    patchRow(id, {
      refreshing: false,
      open: result.ok,
      models: result.ok ? result.data.models : rows[id]?.models,
      error: result.ok ? undefined : result.error,
    })
    if (result.ok) setNotice({ tone: "ok", text: `${id}：发现 ${result.data.models.length} 个模型` })
    else setNotice({ tone: "bad", text: `${id}：${result.error}` })
  }

  const toggleModels = async (id: string) => {
    const row = rows[id]
    if (row?.open) {
      patchRow(id, { open: false })
      return
    }
    patchRow(id, { open: true, loadingModels: true, error: undefined })
    const result = await apiCall<{ models: ModelInfo[] }>(`/providers/${encodeURIComponent(id)}/models`)
    patchRow(id, {
      loadingModels: false,
      models: result.ok ? result.data.models : [],
      error: result.ok ? undefined : result.error,
    })
  }

  const setEnabled = async (provider: ProviderRecord, enabled: boolean) => {
    setBusy(provider.id)
    const result = await apiCall(`/providers/${encodeURIComponent(provider.id)}`, { method: "PATCH", body: { enabled } })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `${provider.id} 已${enabled ? "启用" : "停用"}` })
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: `${provider.id}：${result.error}` })
    }
  }

  const saveProvider = async (provider: ProviderRecord, payload: ProviderUpdatePayload): Promise<string | null> => {
    const result = await apiCall<{ provider: ProviderRecord }>(`/providers/${encodeURIComponent(provider.id)}`, {
      method: "PATCH",
      body: payload,
    })
    if (!result.ok) return result.error
    setNotice({ tone: "ok", text: `${provider.id} 配置已保存` })
    setEditingProvider(null)
    router.refresh()
    return null
  }

  const remove = async (provider: ProviderRecord) => {
    if (!window.confirm(`删除供应商 ${provider.id}？用量记录不会被删除。`)) return
    setBusy(provider.id)
    const result = await apiCall(`/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `${provider.id} 已删除` })
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: `${provider.id}：${result.error}` })
    }
  }

  const copyBaseUrl = async (provider: ProviderRecord) => {
    if (!provider.baseUrl) return
    try {
      await navigator.clipboard.writeText(provider.baseUrl)
      setCopiedId(provider.id)
      window.setTimeout(() => setCopiedId((current) => current === provider.id ? null : current), 1600)
    } catch {
      setNotice({ tone: "bad", text: `无法复制 ${provider.id} 的 Base URL，请检查浏览器剪贴板权限。` })
    }
  }

  const create = async () => {
    const parsed = buildCreateProviderPayload(form)
    if (!parsed.ok) {
      setNotice({ tone: "bad", text: parsed.error })
      return
    }
    setBusy("__create__")
    const result = await apiCall("/providers", { method: "POST", body: parsed.value })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `${parsed.value.id} 已创建` })
      setForm(emptyProviderDraft())
      setSelectedPreset("custom")
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: result.error })
    }
  }

  const enabledCount = providers.filter((provider) => provider.enabled).length

  return (
    <div className="space-y-7">
      {notice ? (
        <div
          role={notice.tone === "bad" ? "alert" : "status"}
          aria-live={notice.tone === "bad" ? "assertive" : "polite"}
          className={notice.tone === "ok"
            ? "rounded-md border border-positive/35 bg-positive/10 px-3 py-2 text-xs text-positive"
            : "rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger"}
        >
          {notice.text}
        </div>
      ) : null}

      <section aria-labelledby="providers-heading" className="space-y-3">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div>
            <h2 id="providers-heading" className="text-base font-semibold tracking-tight text-foreground">已配置供应商</h2>
            <p className="mt-1 text-xs text-subtle">连接状态、配置引用与已发现模型。</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-label={`${providers.length} 个供应商，${enabledCount} 个已启用`}>
            <Badge tone="neutral">{providers.length} 个</Badge>
            <span>{enabledCount} 个启用</span>
          </div>
        </header>

        {providers.length === 0 ? (
          <EmptyState
            title="还没有配置供应商"
            description="从下方选择一个服务预设，或填写自定义端点。密钥只保存引用，不会进入看板。"
            action={<button type="button" onClick={() => document.getElementById("provider-id")?.focus()} className="rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-hover">开始配置</button>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {providers.map((provider) => {
              const row = rows[provider.id] ?? {}
              const modelRackId = `provider-models-${encodeURIComponent(provider.id)}`
              const statusTone = row.status ? (row.status.ok ? "ok" : "bad") : "muted"
              return (
                <article key={provider.id} className="relative overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
                  <span className={`absolute inset-y-0 left-0 w-1 ${provider.enabled ? "bg-positive" : "bg-border-strong"}`} aria-hidden="true" />
                  <div className="p-4 pl-5">
                    <header className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary-soft font-mono text-sm font-semibold text-primary" aria-hidden="true">
                          {provider.name.trim().slice(0, 1).toUpperCase() || "?"}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-semibold text-foreground">{provider.name || provider.id}</h3>
                            <Badge tone="info">{provider.protocol ?? "openai-compatible"}</Badge>
                          </div>
                          <code className="mt-1 block truncate font-mono text-[11px] text-subtle">{provider.id}</code>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <Badge tone={statusTone}>
                            <span className={`mr-1.5 inline-block size-1.5 rounded-full ${row.status ? (row.status.ok ? "bg-positive" : "bg-danger") : "bg-subtle"}`} aria-hidden="true" />
                            {row.status ? (row.status.ok ? "连接正常" : "连接失败") : "尚未检测"}
                          </Badge>
                          {typeof row.status?.latencyMs === "number" ? (
                            <Badge tone={row.status.ok ? "ok" : "bad"}>
                              <span aria-label="连接延迟">{formatMs(row.status.latencyMs)}</span>
                            </Badge>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={provider.enabled}
                          aria-label={`${provider.name || provider.id}：${provider.enabled ? "已启用" : "已停用"}`}
                          onClick={() => void setEnabled(provider, !provider.enabled)}
                          disabled={busy === provider.id}
                          className="group inline-flex shrink-0 items-center gap-2 rounded-md p-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                        >
                          <span className={`relative h-5 w-9 rounded-full transition-colors ${provider.enabled ? "bg-positive" : "bg-border-strong"}`} aria-hidden="true">
                            <span className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-surface shadow-sm transition-transform ${provider.enabled ? "translate-x-4" : "translate-x-0"}`} />
                          </span>
                          <span>{provider.enabled ? "启用" : "停用"}</span>
                        </button>
                      </div>
                    </header>

                    <div className="mt-4 grid gap-x-5 gap-y-3 border-y border-border/80 py-3 sm:grid-cols-2">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-subtle">Base URL</div>
                        <div className="mt-1 flex min-w-0 items-start gap-2">
                          <code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-foreground/90">{provider.baseUrl || "未配置"}</code>
                          {provider.baseUrl ? (
                            <button type="button" onClick={() => void copyBaseUrl(provider)} className="shrink-0 rounded px-1.5 py-1 text-[11px] font-medium text-primary hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label={`复制 ${provider.id} 的 Base URL`}>
                              {copiedId === provider.id ? "已复制" : "复制"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium text-subtle">API Key 引用</div>
                        <div className="mt-1 flex min-w-0 items-start gap-2">
                          <span className="mt-0.5 shrink-0 text-primary" aria-hidden="true">⌑</span>
                          <code className="min-w-0 break-all font-mono text-xs leading-5 text-foreground/90">{provider.apiKeyRef || "未配置"}</code>
                        </div>
                      </div>
                    </div>

                    {row.status?.message ? <p className={`mt-3 break-words text-xs ${row.status.ok ? "text-subtle" : "text-danger"}`}>{row.status.message}</p> : null}
                    {row.status?.checkedAt ? <p className="mt-1 text-[11px] text-subtle">最近检测：{formatDateTime(row.status.checkedAt)}</p> : null}
                    {row.error ? <p role="alert" className="mt-2 break-words text-xs text-danger">{row.error}</p> : null}

                    <div className="mt-4">
                      <button
                        type="button"
                        aria-expanded={Boolean(row.open)}
                        aria-controls={modelRackId}
                        onClick={() => void toggleModels(provider.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-md bg-surface-muted px-3 py-2 text-left text-xs font-medium text-foreground/85 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <span>模型机架 <span className="ml-1 font-normal text-subtle">{row.models ? `· ${row.models.length} 个已发现` : "· 查看已发现模型"}</span></span>
                        <span className="font-mono text-subtle" aria-hidden="true">{row.open ? "−" : "+"}</span>
                      </button>
                      {row.open ? (
                        <div id={modelRackId} className="mt-2 rounded-md border border-border/80 px-3 py-3">
                          {row.loadingModels ? (
                            <p role="status" className="text-xs text-subtle">正在读取模型目录…</p>
                          ) : (row.models?.length ?? 0) === 0 ? (
                            <p className="text-xs leading-5 text-subtle">暂无已发现模型。可以同步一次模型目录，或确认供应商端点可访问。</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {row.models?.map((model) => (
                                <span key={model.ref} title={`来源：${model.source}${model.contextWindow ? `；上下文 ${model.contextWindow}` : ""}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
                                  <code className="truncate font-mono text-[11px] text-foreground/90">{model.modelId}</code>
                                  <span className="shrink-0 text-[10px] text-subtle">{model.source}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>

                    <footer className="mt-4 flex flex-wrap items-center gap-2">
                      <button type="button" onClick={() => void test(provider.id)} disabled={row.testing} className={`${toolButtonClass} border-primary/30 bg-primary-soft text-primary hover:opacity-85`}>
                        {row.testing ? "测试中…" : "测试连接"}
                      </button>
                      <button type="button" onClick={() => void refreshModels(provider.id)} disabled={row.refreshing} className={toolButtonClass}>
                        {row.refreshing ? "同步中…" : "同步模型"}
                      </button>
                      <button type="button" onClick={() => setEditingProvider(provider)} className={toolButtonClass}>编辑配置</button>
                      <button type="button" onClick={() => void remove(provider)} disabled={busy === provider.id} className="inline-flex items-center justify-center rounded-md border border-danger/35 px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-50">
                        删除
                      </button>
                      <button type="button" disabled title="mik serve 目前没有 defaultModel 端点，无法从看板设置默认模型" className="ml-auto cursor-not-allowed rounded-md border border-border px-2.5 py-1.5 text-xs text-subtle/85" aria-label="设为默认模型：当前服务端暂不支持">
                        设为默认
                      </button>
                    </footer>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section id="provider-create" aria-labelledby="provider-create-title" className="overflow-hidden rounded-xl border border-border bg-surface">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div>
            <h2 id="provider-create-title" className="text-base font-semibold tracking-tight text-foreground">新增供应商</h2>
            <p className="mt-1 text-xs text-subtle">先选服务模板，再核对端点和密钥引用。</p>
          </div>
          <Badge tone="info">只保存密钥引用</Badge>
        </header>

        <div className="space-y-5 p-4 sm:p-5">
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-muted-foreground">快速预设</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
              {PROVIDER_PRESETS.map((preset) => {
                const selected = selectedPreset === preset.id
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setForm(draftFromPreset(preset.id))
                      setSelectedPreset(preset.id)
                    }}
                    className={`min-h-16 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? "border-primary bg-primary-soft" : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover"}`}
                  >
                    <span className={`block text-xs font-semibold ${selected ? "text-primary" : "text-foreground"}`}>{preset.label}</span>
                    <span className="mt-1 block text-[10px] text-subtle">{preset.hint}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <label htmlFor="provider-id" className="text-xs font-medium text-muted-foreground">
              Provider ID <span className="text-danger">*</span>
              <input
                id="provider-id"
                className={inputClass}
                value={form.id}
                onChange={(event) => updateForm({ id: event.target.value })}
                placeholder="my-gateway"
                autoComplete="off"
                maxLength={64}
                pattern="[a-zA-Z0-9_.-]+"
                aria-describedby="provider-id-help"
                required
              />
              <span id="provider-id-help" className="mt-1 block text-[10px] font-normal text-subtle">1–64 位字母、数字、点、下划线或短横线。</span>
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              显示名称
              <input className={inputClass} value={form.name} onChange={(event) => updateForm({ name: event.target.value })} placeholder="My Gateway" autoComplete="off" />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              协议
              <select className={inputClass} value={form.protocol} onChange={(event) => updateForm({ protocol: event.target.value })}>
                {PROVIDER_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-muted-foreground sm:col-span-2 xl:col-span-1">
              Base URL
              <input className={`${inputClass} font-mono text-xs`} value={form.baseUrl} onChange={(event) => updateForm({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" autoComplete="url" spellCheck={false} />
            </label>
            <label className="text-xs font-medium text-muted-foreground sm:col-span-2 xl:col-span-1">
              API Key 引用
              <input className={`${inputClass} font-mono text-xs`} value={form.apiKeyRef} onChange={(event) => updateForm({ apiKeyRef: event.target.value })} placeholder="env:OPENAI_API_KEY" autoComplete="off" spellCheck={false} />
            </label>
            <label className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground sm:col-span-2 xl:col-span-1">
              <input type="checkbox" checked={form.enabled} onChange={(event) => updateForm({ enabled: event.target.checked })} className="size-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
              <span><span className="block font-medium text-foreground">创建后立即启用</span><span className="mt-0.5 block text-[10px] text-subtle">稍后也可以在供应商卡片中切换。</span></span>
            </label>
          </div>

          <details className="rounded-md border border-border">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">高级配置：自定义 Headers</summary>
            <div className="border-t border-border p-3">
              <label htmlFor="provider-headers" className="text-xs font-medium text-muted-foreground">Headers（JSON）</label>
              <textarea id="provider-headers" className={`${inputClass} min-h-20 resize-y font-mono text-xs`} value={form.headersJson} onChange={(event) => updateForm({ headersJson: event.target.value })} spellCheck={false} />
              <p className="mt-1 text-[11px] text-subtle">输入字符串键值对象，例如 {'{ "HTTP-Referer": "https://example.com" }'}。</p>
            </div>
          </details>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="max-w-xl text-[11px] leading-5 text-subtle">看板不会读取真实密钥。`apiKeyRef` 只接受由 mik 服务端解析的 `env:NAME` / `file:path` 等引用。</p>
            <button type="button" onClick={() => void create()} disabled={busy === "__create__"} className="rounded-md border border-primary bg-primary px-4 py-2 text-xs font-semibold text-surface hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-wait disabled:opacity-60">
              {busy === "__create__" ? "创建中…" : "创建供应商"}
            </button>
          </div>
        </div>
      </section>

      {editingProvider ? (
        <EditProviderModal
          key={editingProvider.id}
          provider={editingProvider}
          onClose={() => setEditingProvider(null)}
          onSave={(payload) => saveProvider(editingProvider, payload)}
        />
      ) : null}
    </div>
  )
}
