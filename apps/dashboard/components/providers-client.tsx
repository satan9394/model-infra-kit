"use client"

import { useRouter } from "next/navigation"
import { Fragment, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { formatDateTime, formatMs } from "@/lib/format"
import type { ModelInfo, ProviderRecord, ProviderStatus } from "@/lib/types"
import { Badge, Card, EmptyState, TableWrap, Td, Th } from "@/components/ui"

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
  "w-full rounded-md border border-slate-800 bg-slate-900/70 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-600"

export function ProvidersClient({ providers }: { providers: ProviderRecord[] }) {
  const router = useRouter()
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)
  const [form, setForm] = useState({ id: "", name: "", baseUrl: "", apiKeyRef: "", presetId: "", protocol: "" })

  const patchRow = (id: string, patch: Partial<RowState>) =>
    setRows((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }))

  const test = async (id: string) => {
    patchRow(id, { testing: true, error: undefined })
    const result = await apiCall<{ status: ProviderStatus }>(`/providers/${encodeURIComponent(id)}/test`, { method: "POST" })
    patchRow(id, { testing: false, status: result.ok ? result.data.status : undefined, error: result.ok ? undefined : result.error })
    if (result.ok) setNotice({ tone: result.data.status.ok ? "ok" : "bad", text: `${id}：${result.data.status.message}` })
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
  }

  const toggleModels = async (id: string) => {
    const row = rows[id]
    if (row?.open) {
      patchRow(id, { open: false })
      return
    }
    patchRow(id, { open: true, loadingModels: true })
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

  const create = async () => {
    if (!form.id.trim()) {
      setNotice({ tone: "bad", text: "id 必填（只允许字母数字 . _ - ，最长 64，不能含冒号）" })
      return
    }
    const body: Record<string, unknown> = { id: form.id.trim() }
    if (form.name.trim()) body.name = form.name.trim()
    if (form.baseUrl.trim()) body.baseUrl = form.baseUrl.trim()
    if (form.apiKeyRef.trim()) body.apiKeyRef = form.apiKeyRef.trim()
    if (form.presetId.trim()) body.presetId = form.presetId.trim()
    if (form.protocol.trim()) body.protocol = form.protocol.trim()
    setBusy("__create__")
    const result = await apiCall("/providers", { method: "POST", body })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `${form.id} 已创建` })
      setForm({ id: "", name: "", baseUrl: "", apiKeyRef: "", presetId: "", protocol: "" })
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: result.error })
    }
  }

  return (
    <div className="space-y-4">
      {notice ? (
        <div
          className={
            notice.tone === "ok"
              ? "rounded-lg border border-emerald-900/70 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200"
              : "rounded-lg border border-rose-900/70 bg-rose-950/40 px-3 py-2 text-xs text-rose-200"
          }
        >
          {notice.text}
        </div>
      ) : null}

      <Card title="供应商列表" subtitle="GET /api/providers" padded={false}>
        {providers.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="还没有配置供应商"
              description="用下面的表单添加一个，或运行 `mik provider add`。seed 脚本会写入一个 mock 供应商用于验收。"
            />
          </div>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>ID / 名称</Th>
                <Th>协议</Th>
                <Th>Base URL</Th>
                <Th>密钥引用</Th>
                <Th>状态</Th>
                <Th>操作</Th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => {
                const row = rows[provider.id] ?? {}
                return (
                  <Fragment key={provider.id}>
                    <tr>
                      <Td>
                        <div className="font-mono text-slate-200">{provider.id}</div>
                        <div className="text-xs text-slate-500">{provider.name}</div>
                      </Td>
                      <Td className="font-mono text-xs">{provider.protocol ?? "—"}</Td>
                      <Td className="max-w-[240px] break-all font-mono text-xs text-slate-400">{provider.baseUrl ?? "—"}</Td>
                      <Td className="font-mono text-xs text-slate-400">{provider.apiKeyRef ?? "（未配置）"}</Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge tone={provider.enabled ? "ok" : "muted"}>{provider.enabled ? "启用" : "停用"}</Badge>
                          {row.status ? (
                            <Badge tone={row.status.ok ? "ok" : "bad"}>
                              {row.status.ok ? "连接正常" : "连接失败"}
                              {typeof row.status.latencyMs === "number" ? ` ${formatMs(row.status.latencyMs)}` : ""}
                            </Badge>
                          ) : null}
                        </div>
                        {row.status ? <div className="mt-1 text-[11px] text-slate-500">{row.status.message}</div> : null}
                        {row.error ? <div className="mt-1 text-[11px] text-rose-400">{row.error}</div> : null}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() => void test(provider.id)}
                            disabled={row.testing}
                            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                          >
                            {row.testing ? "测试中…" : "测试连接"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleModels(provider.id)}
                            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                          >
                            {row.open ? "收起模型" : "模型列表"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void refreshModels(provider.id)}
                            disabled={row.refreshing}
                            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                          >
                            {row.refreshing ? "同步中…" : "刷新模型"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void setEnabled(provider, !provider.enabled)}
                            disabled={busy === provider.id}
                            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                          >
                            {provider.enabled ? "停用" : "启用"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(provider)}
                            disabled={busy === provider.id}
                            className="rounded border border-rose-900/70 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950/50 disabled:opacity-50"
                          >
                            删除
                          </button>
                          <button
                            type="button"
                            disabled
                            title="mik serve 目前没有 defaultModel 端点，无法从看板设置默认模型"
                            className="cursor-not-allowed rounded border border-slate-800 px-2 py-1 text-[11px] text-slate-600"
                          >
                            设为默认
                          </button>
                        </div>
                      </Td>
                    </tr>
                    {row.open ? (
                      <tr>
                        <Td className="bg-slate-900/40" />
                        <td colSpan={5} className="border-b border-slate-800/60 bg-slate-900/40 px-3 py-3">
                          {row.loadingModels ? (
                            <span className="text-xs text-slate-500">加载中…</span>
                          ) : (row.models?.length ?? 0) === 0 ? (
                            <span className="text-xs text-slate-500">该供应商暂无已发现模型（点「刷新模型」探测）。</span>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {row.models?.map((model) => (
                                <span
                                  key={model.ref}
                                  className="rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-300"
                                  title={`来源 ${model.source}${model.contextWindow ? ` · 上下文 ${model.contextWindow}` : ""}`}
                                >
                                  {model.modelId}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card title="新增供应商" subtitle="POST /api/providers · 密钥只保存引用，不落库">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs text-slate-500">
            id（必填）
            <input className={inputClass} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="my-gateway" />
          </label>
          <label className="text-xs text-slate-500">
            名称
            <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My Gateway" />
          </label>
          <label className="text-xs text-slate-500">
            presetId
            <input className={inputClass} value={form.presetId} onChange={(e) => setForm({ ...form, presetId: e.target.value })} placeholder="deepseek / openai / …" />
          </label>
          <label className="text-xs text-slate-500">
            baseUrl
            <input className={inputClass} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://127.0.0.1:3212/v1" />
          </label>
          <label className="text-xs text-slate-500">
            apiKeyRef
            <input className={inputClass} value={form.apiKeyRef} onChange={(e) => setForm({ ...form, apiKeyRef: e.target.value })} placeholder="env:DEEPSEEK_API_KEY" />
          </label>
          <label className="text-xs text-slate-500">
            protocol
            <input className={inputClass} value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })} placeholder="openai-compatible" />
          </label>
        </div>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy === "__create__"}
          className="mt-3 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          {busy === "__create__" ? "创建中…" : "创建"}
        </button>
        <p className="mt-2 text-[11px] text-slate-500">
          看板不会读取任何真实密钥：<code>apiKeyRef</code> 只是 <code>env:NAME</code> / <code>file:path</code> 形式的引用，由 mik 在服务端解析。
        </p>
      </Card>
    </div>
  )
}
