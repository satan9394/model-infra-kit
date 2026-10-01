"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { AddProviderModal } from "@/components/add-provider-modal"
import { EditProviderModal } from "@/components/edit-provider-modal"
import { apiCall } from "@/lib/client-api"
import { getProviderBrand } from "@/lib/provider-brands"
import type {
  ProviderCreatePayload,
  ProviderUpdatePayload,
} from "@/lib/provider-presets"
import { formatDateTime } from "@/lib/format"
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

const actionBtnClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-50"

function ActionIcon({ action, spinning = false }: { action: "test" | "sync" | "models" | "edit" | "delete"; spinning?: boolean }) {
  const paths = {
    test: "M13 2 3 14h8l-1 8 11-12h-8l1-8Z",
    sync: "M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.2 3M4.7 14.9a8 8 0 0 0 13.2 3",
    models: "m12 3 9 5-9 5-9-5 9-5ZM3 8v8l9 5 9-5V8M12 13v8M7.5 5.5l9 5",
    edit: "m16 3 5 5-12 12-6 1 1-6L16 3ZM14 5l5 5",
    delete: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={`size-4 ${spinning ? "motion-safe:animate-spin" : ""}`}>
      <path d={paths[action]} />
    </svg>
  )
}

export function ProvidersClient({ providers }: { providers: ProviderRecord[] }) {
  const router = useRouter()
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ProviderRecord | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const patchRow = (id: string, patch: Partial<RowState>) =>
    setRows((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }))

  const test = async (id: string) => {
    patchRow(id, { testing: true, error: undefined })
    const result = await apiCall<{ status: ProviderStatus }>(`/providers/${encodeURIComponent(id)}/test`, {
      method: "POST",
    })
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
    const result = await apiCall<{ models: ModelInfo[] }>(`/providers/${encodeURIComponent(id)}/models/refresh`, {
      method: "POST",
    })
    patchRow(id, {
      refreshing: false,
      open: result.ok,
      models: result.ok ? result.data.models : rows[id]?.models,
      error: result.ok ? undefined : result.error,
    })
    if (result.ok) {
      setNotice({ tone: "ok", text: `${id}：发现 ${result.data.models.length} 个可用模型` })
    } else {
      setNotice({ tone: "bad", text: `${id}：${result.error}` })
    }
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
    const result = await apiCall(`/providers/${encodeURIComponent(provider.id)}`, {
      method: "PATCH",
      body: { enabled },
    })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `${provider.id} 已${enabled ? "启用" : "停用"}` })
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: `${provider.id}：${result.error}` })
    }
  }

  const saveProvider = async (
    provider: ProviderRecord,
    payload: ProviderUpdatePayload
  ): Promise<string | null> => {
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

  const handleCreateProvider = async (
    payload: ProviderCreatePayload
  ): Promise<string | null> => {
    setBusy("__create__")
    const result = await apiCall("/providers", { method: "POST", body: payload })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `${payload.id} 已创建并保存` })
      setIsAddModalOpen(false)
      router.refresh()
      return null
    }
    return result.error
  }

  const remove = async (provider: ProviderRecord) => {
    if (!window.confirm(`确认删除供应商 ${provider.id}？已采集的调用用量和日志仍会保留。`)) return
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
      window.setTimeout(() => setCopiedId((current) => (current === provider.id ? null : current)), 1600)
    } catch {
      setNotice({ tone: "bad", text: `无法复制 ${provider.id} 的 Base URL，请检查浏览器剪贴板权限。` })
    }
  }

  const enabledCount = providers.filter((provider) => provider.enabled).length

  return (
    <div className="space-y-6">
      {notice ? (
        <div
          role={notice.tone === "bad" ? "alert" : "status"}
          aria-live={notice.tone === "bad" ? "assertive" : "polite"}
          className={`flex items-center justify-between rounded-xl border px-4 py-3 text-xs font-medium transition-all ${
            notice.tone === "ok"
              ? "border-positive/35 bg-positive/10 text-positive"
              : "border-danger/35 bg-danger/10 text-danger"
          }`}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="ml-3 text-xs opacity-70 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ) : null}

      <section aria-labelledby="providers-heading" className="space-y-4">
        {/* Streamlined Top Control Header */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border/80 pb-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 id="providers-heading" className="text-base font-semibold tracking-tight text-foreground">
                已配置供应商
              </h2>
              <div
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                aria-label={`${providers.length} 个供应商，${enabledCount} 个已启用`}
              >
                <Badge tone="neutral">{providers.length} 个</Badge>
                <span className="text-[11px] text-subtle">{enabledCount} 个已启用</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-subtle">
              管理供应商端点，测试连接并同步可用模型。
            </p>
          </div>

          <button
            type="button"
            onClick={() => setIsAddModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-primary bg-primary px-3.5 py-2 text-xs font-semibold text-surface shadow-xs transition-transform hover:opacity-90 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <span className="text-sm font-bold leading-none">+</span>
            <span>添加供应商</span>
          </button>
        </header>

        {providers.length === 0 ? (
          <EmptyState
            title="还没有配置供应商"
            description="点击上方「+ 添加供应商」或从预设模板建立端点。密钥只保存引用，不会进入看板。"
            action={
              <button
                type="button"
                onClick={() => setIsAddModalOpen(true)}
                className="rounded-xl border border-border-strong bg-surface px-4 py-2 text-xs font-medium text-foreground shadow-xs hover:bg-surface-hover"
              >
                开始配置
              </button>
            }
          />
        ) : (
          <div className="space-y-3">
            {providers.map((provider) => {
              const row = rows[provider.id] ?? {}
              const modelRackId = `provider-models-${encodeURIComponent(provider.id)}`
              const brand = getProviderBrand(provider.id, provider.presetId, provider.protocol)

              // Status determination
              const isOnline = row.status?.ok === true
              const isOffline = row.status && !row.status.ok

              return (
                <article
                  key={provider.id}
                  className="group/provider relative overflow-hidden rounded-xl border border-border bg-surface p-3.5 transition-all duration-200 hover:border-border-strong hover:shadow-xs motion-reduce:transition-none"
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-0 bg-gradient-to-r to-transparent transition-opacity duration-300 motion-reduce:transition-none ${provider.enabled ? "from-primary/10 opacity-100" : "opacity-0"}`}
                  />
                  <div className="relative">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <div
                          className="flex size-9 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-bold text-white"
                          style={{ backgroundColor: brand.color }}
                          aria-hidden="true"
                        >
                          {brand.shortTag}
                        </div>
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-semibold tracking-tight text-foreground" title={provider.name || provider.id}>
                              {provider.name || provider.id}
                            </h3>
                            <Badge tone="info">{provider.protocol ?? "openai-compatible"}</Badge>
                            <code className="truncate font-mono text-[11px] text-subtle" title={provider.id}>{provider.id}</code>
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
                            {provider.baseUrl ? (
                              <button
                                type="button"
                                onClick={() => void copyBaseUrl(provider)}
                                className="min-w-0 max-w-full truncate rounded text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                aria-label={`复制 ${provider.id} 的 Base URL`}
                                title={provider.baseUrl}
                              >
                                {copiedId === provider.id ? "已复制 ✓" : provider.baseUrl}
                              </button>
                            ) : <span>默认官方端点</span>}
                            <code className="min-w-0 max-w-full truncate text-subtle" title={provider.apiKeyRef || "未配置 (免鉴权)"}>
                              {provider.apiKeyRef || "未配置 (免鉴权)"}
                            </code>
                          </div>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <div role="status" className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${
                          row.testing ? "border-warning/30 bg-warning/10 text-warning"
                            : isOnline ? "border-positive/30 bg-positive/10 text-positive"
                              : isOffline ? "border-danger/30 bg-danger/10 text-danger"
                                : "border-border bg-surface-muted/50 text-subtle"
                        }`}>
                          <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${row.testing || isOnline || isOffline ? "motion-safe:animate-pulse shadow-[0_0_8px_currentColor]" : ""}`} />
                          {row.testing ? "测速中" : isOnline ? "在线" : isOffline ? "异常" : "未测速"}
                        </div>
                        {typeof row.status?.latencyMs === "number" ? (
                          <span
                            className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px] tabular-nums ${
                              row.status.latencyMs < 300
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : row.status.latencyMs < 500
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                                  : row.status.latencyMs < 800
                                    ? "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400"
                                    : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
                            }`}
                            aria-label="网络延迟"
                          >
                            {Math.round(row.status.latencyMs)}ms
                          </span>
                        ) : null}

                        <div className="provider-actions flex items-center gap-1 opacity-0 pointer-events-none group-hover/provider:opacity-100 group-focus-within/provider:opacity-100 group-hover/provider:pointer-events-auto group-focus-within/provider:pointer-events-auto transition-opacity duration-200 motion-reduce:transition-none">
                          <button type="button" onClick={() => void test(provider.id)} disabled={row.testing} title="测试网络连接与测速" aria-label={row.testing ? "测速中" : "测速"} className={actionBtnClass}>
                            <ActionIcon action="test" spinning={row.testing} />
                          </button>
                          <button type="button" onClick={() => void refreshModels(provider.id)} disabled={row.refreshing} title="同步最新模型目录" aria-label={row.refreshing ? "同步中" : "同步模型"} className={actionBtnClass}>
                            <ActionIcon action="sync" spinning={row.refreshing} />
                          </button>
                          <button type="button" aria-expanded={Boolean(row.open)} aria-controls={modelRackId} aria-label={row.open ? "收起模型列表" : "展开模型列表"} title={row.models ? `模型列表（${row.models.length} 款）` : "模型列表"} onClick={() => void toggleModels(provider.id)} className={`${actionBtnClass} ${row.open ? "bg-primary-soft text-primary" : ""}`}>
                            <ActionIcon action="models" />
                          </button>
                          <button type="button" onClick={() => setEditingProvider(provider)} title="编辑供应商配置" aria-label="编辑供应商配置" className={actionBtnClass}>
                            <ActionIcon action="edit" />
                          </button>
                          <button type="button" onClick={() => void remove(provider)} disabled={busy === provider.id} title="删除该供应商" aria-label="删除该供应商" className={`${actionBtnClass} hover:bg-danger/10 hover:text-danger focus-visible:ring-danger`}>
                            <ActionIcon action="delete" />
                          </button>
                        </div>

                        <button
                          type="button"
                          role="switch"
                          aria-checked={provider.enabled}
                          aria-label={`${provider.name || provider.id}：${provider.enabled ? "已启用" : "已停用"}`}
                          onClick={() => void setEnabled(provider, !provider.enabled)}
                          disabled={busy === provider.id}
                          className="inline-flex shrink-0 items-center rounded-lg p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                        >
                          <span aria-hidden="true" className={`relative h-5 w-9 rounded-full transition-colors ${provider.enabled ? "bg-positive" : "bg-border-strong"}`}>
                            <span className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-xs transition-transform motion-reduce:transition-none ${provider.enabled ? "translate-x-4" : "translate-x-0"}`} />
                          </span>
                        </button>
                      </div>
                    </div>
                    {/* Status Notice message if any */}
                    {row.status?.message ? (
                      <p
                        className={`mt-2.5 break-words pl-2 text-xs ${
                          row.status.ok ? "text-subtle" : "font-medium text-danger"
                        }`}
                      >
                        {row.status.message}
                      </p>
                    ) : null}
                    {row.status?.checkedAt ? (
                      <p className="mt-1 pl-2 text-[10px] text-subtle">
                        最近检测：{formatDateTime(row.status.checkedAt)}
                      </p>
                    ) : null}
                    {row.error ? (
                      <p role="alert" className="mt-2 break-words pl-2 text-xs font-medium text-danger">
                        {row.error}
                      </p>
                    ) : null}
                    <div
                      id={modelRackId}
                      inert={!row.open}
                      aria-hidden={!row.open}
                      className={`grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none ${row.open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className="mt-3 rounded-lg border border-border/80 bg-surface-muted/50 p-3">
                        {row.loadingModels ? (
                          <p role="status" className="text-xs text-subtle">
                            正在读取模型目录…
                          </p>
                        ) : (row.models?.length ?? 0) === 0 ? (
                          <p className="text-xs leading-5 text-subtle">
                            暂无已发现模型。点击「同步模型」图标拉取最新目录。
                          </p>
                        ) : (
                          <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto pr-1">
                            {row.models?.map((model) => (
                              <span
                                key={model.ref}
                                title={`来源：${model.source}${model.contextWindow ? `；上下文 ${model.contextWindow}` : ""}`}
                                className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-0.5 shadow-2xs"
                              >
                                <code className="truncate font-mono text-[11px] text-foreground/90">
                                  {model.modelId}
                                </code>
                                <span className="shrink-0 text-[9px] text-subtle">{model.source}</span>
                              </span>
                            ))}
                          </div>
                        )}
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {/* Add Provider Modal (Replaces permanent bottom form) */}
      {isAddModalOpen ? (
        <AddProviderModal
          onClose={() => setIsAddModalOpen(false)}
          onCreate={handleCreateProvider}
        />
      ) : null}

      {/* Edit Provider Modal */}
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
