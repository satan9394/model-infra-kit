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

const actionBtnClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground transition-all hover:border-border-strong hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-50"

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
              对标 CC Switch 现代桌面流线质感：品牌快速识别、健康延迟监测与轻量悬停控制。
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
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {providers.map((provider) => {
              const row = rows[provider.id] ?? {}
              const modelRackId = `provider-models-${encodeURIComponent(provider.id)}`
              const brand = getProviderBrand(provider.id, provider.presetId, provider.protocol)

              // Status determination
              const isTested = Boolean(row.status)
              const isOnline = row.status?.ok === true
              const isOffline = row.status && !row.status.ok

              return (
                <article
                  key={provider.id}
                  className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-xs transition-all hover:border-border-strong hover:shadow-md"
                >
                  {/* Left Brand Active Indicator Bar */}
                  <span
                    className={`absolute inset-y-0 left-0 w-1 transition-colors ${
                      provider.enabled ? "bg-primary" : "bg-border-strong/60"
                    }`}
                    aria-hidden="true"
                  />

                  <div>
                    {/* Top Row: Brand Avatar, Name, Protocol, Latency, and Switch */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pl-2">
                      <div className="flex min-w-0 items-center gap-3">
                        <div
                          className="flex size-10 shrink-0 items-center justify-center rounded-xl font-mono text-xs font-bold text-white shadow-xs"
                          style={{ backgroundColor: brand.color }}
                          aria-hidden="true"
                        >
                          {brand.shortTag}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
                              {provider.name || provider.id}
                            </h3>
                            <Badge tone="info">{provider.protocol ?? "openai-compatible"}</Badge>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2">
                            <code className="truncate font-mono text-[11px] text-subtle">{provider.id}</code>
                            {/* Health Indicator Dot */}
                            <span className="flex items-center gap-1.5 text-[11px] font-medium text-subtle">
                              <span
                                className={`size-2 rounded-full transition-colors ${
                                  row.testing
                                    ? "animate-pulse bg-warn"
                                    : isOnline
                                      ? "bg-positive shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                                      : isOffline
                                        ? "bg-danger shadow-[0_0_8px_rgba(239,68,68,0.5)]"
                                        : "bg-subtle/60"
                                }`}
                                aria-hidden="true"
                              />
                              <span>
                                {row.testing
                                  ? "测速中"
                                  : isOnline
                                    ? "在线"
                                    : isOffline
                                      ? "异常"
                                      : "未测速"}
                              </span>
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Top Right: Latency Pill & Enabled Switch */}
                      <div className="flex items-center gap-2.5">
                        {typeof row.status?.latencyMs === "number" ? (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold tracking-tight shadow-xs ${
                              row.status.ok
                                ? "border border-positive/30 bg-positive/10 text-positive"
                                : "border border-danger/30 bg-danger/10 text-danger"
                            }`}
                            aria-label="网络延迟"
                          >
                            <span>⚡</span>
                            <span>{formatMs(row.status.latencyMs)}</span>
                          </span>
                        ) : null}

                        <button
                          type="button"
                          role="switch"
                          aria-checked={provider.enabled}
                          aria-label={`${provider.name || provider.id}：${provider.enabled ? "已启用" : "已停用"}`}
                          onClick={() => void setEnabled(provider, !provider.enabled)}
                          disabled={busy === provider.id}
                          className="group inline-flex shrink-0 items-center gap-2 rounded-lg p-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                        >
                          <span
                            className={`relative h-5 w-9 rounded-full transition-colors ${
                              provider.enabled ? "bg-positive" : "bg-border-strong"
                            }`}
                            aria-hidden="true"
                          >
                            <span
                              className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-xs transition-transform ${
                                provider.enabled ? "translate-x-4" : "translate-x-0"
                              }`}
                            />
                          </span>
                        </button>
                      </div>
                    </div>

                    {/* Metadata Strip: Base URL & API Key Ref */}
                    <div className="mt-3.5 grid gap-2.5 rounded-xl border border-border/60 bg-surface-muted/40 p-2.5 pl-3 sm:grid-cols-2">
                      <div className="min-w-0">
                        <span className="text-[10px] font-medium text-subtle">Base URL</span>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                          <code className="truncate font-mono text-xs text-foreground/90">
                            {provider.baseUrl || "默认官方端点"}
                          </code>
                          {provider.baseUrl ? (
                            <button
                              type="button"
                              onClick={() => void copyBaseUrl(provider)}
                              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                              aria-label={`复制 ${provider.id} 的 Base URL`}
                            >
                              {copiedId === provider.id ? "已复制 ✓" : "复制"}
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div className="min-w-0">
                        <span className="text-[10px] font-medium text-subtle">API Key 引用</span>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                          <span className="shrink-0 text-primary" aria-hidden="true">
                            ⌑
                          </span>
                          <code className="truncate font-mono text-xs text-foreground/90">
                            {provider.apiKeyRef || "未配置 (免鉴权)"}
                          </code>
                        </div>
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

                    {/* Model Rack Collapsible Area */}
                    {row.open ? (
                      <div
                        id={modelRackId}
                        className="mt-3 overflow-hidden rounded-xl border border-border/80 bg-surface-muted/50 p-3"
                      >
                        {row.loadingModels ? (
                          <p role="status" className="text-xs text-subtle">
                            正在读取模型目录…
                          </p>
                        ) : (row.models?.length ?? 0) === 0 ? (
                          <p className="text-xs leading-5 text-subtle">
                            暂无已发现模型。点击下方「同步模型」拉取最新目录。
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
                    ) : null}
                  </div>

                  {/* Bottom Action Footer: Model Rack Pill & Lightweight Action Toolbar */}
                  <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 pl-2">
                    <button
                      type="button"
                      aria-expanded={Boolean(row.open)}
                      aria-controls={modelRackId}
                      onClick={() => void toggleModels(provider.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <span>📦</span>
                      <span>
                        {row.models ? `${row.models.length} 款模型` : "模型列表"}
                      </span>
                      <span className="text-[10px] text-subtle" aria-hidden="true">
                        {row.open ? "▴" : "▾"}
                      </span>
                    </button>

                    {/* Lightweight Hover Actions */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void test(provider.id)}
                        disabled={row.testing}
                        title="测试网络连接与测速"
                        className={`${actionBtnClass} text-primary`}
                      >
                        <span>⚡</span>
                        <span>{row.testing ? "测速中" : "测速"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void refreshModels(provider.id)}
                        disabled={row.refreshing}
                        title="同步最新模型目录"
                        className={actionBtnClass}
                      >
                        <span>🔄</span>
                        <span>{row.refreshing ? "同步中" : "同步"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setEditingProvider(provider)}
                        title="编辑供应商配置"
                        className={actionBtnClass}
                      >
                        <span>✏️</span>
                        <span>编辑</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void remove(provider)}
                        disabled={busy === provider.id}
                        title="删除该供应商"
                        className="inline-flex items-center gap-1 rounded-lg border border-danger/30 bg-surface px-2 py-1.5 text-xs font-medium text-danger transition-all hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-50"
                      >
                        <span>🗑️</span>
                      </button>
                    </div>
                  </footer>
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
