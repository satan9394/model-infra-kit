"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { apiCall } from "@/lib/client-api"
import { formatDateTime, formatRate } from "@/lib/format"
import type { ModelInfo, PricingOverride, PricingState } from "@/lib/types"
import { Badge, Card, EmptyState, TableWrap, Td, Th } from "@/components/ui"

const STALE_AFTER_MS = 24 * 60 * 60 * 1000

const inputClass =
  "w-full rounded-md border border-slate-800 bg-slate-900/70 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-slate-600"

interface FormState {
  modelId: string
  displayName: string
  inputPerM: string
  outputPerM: string
  cacheReadPerM: string
  cacheWritePerM: string
}

const EMPTY_FORM: FormState = { modelId: "", displayName: "", inputPerM: "", outputPerM: "", cacheReadPerM: "", cacheWritePerM: "" }

function parseRate(value: string): number | undefined | null {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

export function PricingClient({
  state,
  overrides,
  models,
}: {
  state: PricingState | null
  overrides: PricingOverride[]
  models: ModelInfo[]
}) {
  const router = useRouter()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)

  const stale =
    state?.status === "stale" ||
    state?.status === "error" ||
    (typeof state?.loadedAt === "number" && Date.now() - state.loadedAt > STALE_AFTER_MS)

  const sync = async () => {
    setBusy("__sync__")
    const result = await apiCall<{ state: PricingState }>("/pricing/sync", { method: "POST" })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `价格目录已同步：${result.data.state.status}（来源 ${result.data.state.source ?? "—"}）` })
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: result.error })
    }
  }

  const save = async (modelId: string, payload: Omit<FormState, "modelId">) => {
    const rates = {
      inputPerM: parseRate(payload.inputPerM),
      outputPerM: parseRate(payload.outputPerM),
      cacheReadPerM: parseRate(payload.cacheReadPerM),
      cacheWritePerM: parseRate(payload.cacheWritePerM),
    }
    if (Object.values(rates).some((value) => value === null)) {
      setNotice({ tone: "bad", text: "价格必须是非负数字。" })
      return
    }
    const body: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rates)) if (value !== undefined) body[key] = value
    if (payload.displayName.trim()) body.displayName = payload.displayName.trim()
    // S3: mik 要求至少给出一个单价，否则 400。
    if (Object.keys(body).filter((key) => key !== "displayName").length === 0) {
      setNotice({ tone: "bad", text: "至少填写一个单价（input 或 output）。" })
      return
    }

    setBusy(modelId)
    const result = await apiCall(`/pricing/${encodeURIComponent(modelId)}`, { method: "PUT", body })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `${modelId} 的手动价已保存（优先级高于上游目录）` })
      setForm(EMPTY_FORM)
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: result.error })
    }
  }

  const remove = async (modelId: string) => {
    if (!window.confirm(`撤销 ${modelId} 的手动价？之后会回落到上游目录。`)) return
    setBusy(modelId)
    const result = await apiCall(`/pricing/${encodeURIComponent(modelId)}`, { method: "DELETE" })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: `${modelId} 的手动价已撤销` })
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: result.error })
    }
  }

  const edit = (override: PricingOverride) => {
    setForm({
      modelId: override.modelId,
      displayName: override.displayName ?? "",
      inputPerM: override.inputPerM === undefined ? "" : String(override.inputPerM),
      outputPerM: override.outputPerM === undefined ? "" : String(override.outputPerM),
      cacheReadPerM: override.cacheReadPerM === undefined ? "" : String(override.cacheReadPerM),
      cacheWritePerM: override.cacheWritePerM === undefined ? "" : String(override.cacheWritePerM),
    })
    setNotice({ tone: "ok", text: `正在编辑 ${override.modelId}` })
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

      <Card
        title="价格目录状态"
        subtitle="GET /api/pricing"
        actions={
          <button
            type="button"
            onClick={() => void sync()}
            disabled={busy === "__sync__"}
            className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            {busy === "__sync__" ? "同步中…" : "一键同步"}
          </button>
        }
      >
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <Badge tone={state?.status === "fresh" ? "ok" : state?.status === "stale" ? "warn" : state?.status === "error" ? "bad" : "muted"}>
            {state?.status ?? "未知"}
          </Badge>
          <span>来源 {state?.source ?? "—"}</span>
          <span>加载于 {formatDateTime(state?.loadedAt)}</span>
          {stale ? (
            <span className="rounded border border-amber-800/70 bg-amber-950/40 px-2 py-0.5 text-amber-300">
              价格可能已过期（超过 24h 或同步失败），建议点「一键同步」
            </span>
          ) : null}
        </div>
        {state?.lastError ? (
          <p className="mt-2 break-all font-mono text-xs text-rose-300">上次同步错误：{state.lastError}</p>
        ) : null}
        <p className="mt-2 text-[11px] text-slate-500">
          手动价（override）在 mik 内优先级最高，覆盖 models.dev / openrouter 的目录价；同步只会更新目录，不会动手动价。
        </p>
      </Card>

      <Card
        title={form.modelId ? `编辑手动价 · ${form.modelId}` : "新增 / 覆盖手动价"}
        subtitle="PUT /api/pricing/:modelId · 至少填一个单价（mik 侧 S3 校验）"
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs text-slate-500">
            模型 ID（provider:model 里的 model 部分）
            <input
              className={inputClass}
              list="mik-model-ids"
              value={form.modelId}
              onChange={(event) => setForm({ ...form, modelId: event.target.value })}
              placeholder="deepseek-chat"
            />
          </label>
          <datalist id="mik-model-ids">
            {models.map((model) => (
              <option key={model.ref} value={model.modelId} />
            ))}
          </datalist>
          <label className="text-xs text-slate-500">
            显示名（可选）
            <input className={inputClass} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
          </label>
          <label className="text-xs text-slate-500">
            input / 1M（USD）
            <input className={inputClass} value={form.inputPerM} onChange={(event) => setForm({ ...form, inputPerM: event.target.value })} placeholder="0.27" />
          </label>
          <label className="text-xs text-slate-500">
            output / 1M（USD）
            <input className={inputClass} value={form.outputPerM} onChange={(event) => setForm({ ...form, outputPerM: event.target.value })} placeholder="1.10" />
          </label>
          <label className="text-xs text-slate-500">
            cache_read / 1M（USD）
            <input className={inputClass} value={form.cacheReadPerM} onChange={(event) => setForm({ ...form, cacheReadPerM: event.target.value })} />
          </label>
          <label className="text-xs text-slate-500">
            cache_write / 1M（USD）
            <input className={inputClass} value={form.cacheWritePerM} onChange={(event) => setForm({ ...form, cacheWritePerM: event.target.value })} />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void save(form.modelId.trim(), form)}
            disabled={busy === form.modelId || !form.modelId.trim()}
            className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          >
            {busy === form.modelId ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            onClick={() => setForm(EMPTY_FORM)}
            className="rounded-md border border-slate-800 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            清空
          </button>
        </div>
      </Card>

      <Card title={`手动价（${overrides.length}）`} subtitle="mik 的 pricing_overrides 表" padded={false}>
        {overrides.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="还没有手动价"
              description="上面的表单会写入一条 override；seed 脚本也会写入几条示例价格。"
            />
          </div>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>模型</Th>
                <Th className="text-right">input / 1M</Th>
                <Th className="text-right">output / 1M</Th>
                <Th className="text-right">cache_read / 1M</Th>
                <Th className="text-right">cache_write / 1M</Th>
                <Th>更新时间</Th>
                <Th>操作</Th>
              </tr>
            </thead>
            <tbody>
              {overrides.map((override) => (
                <tr key={override.modelId}>
                  <Td>
                    <div className="font-mono text-slate-200">{override.modelId}</div>
                    {override.displayName ? <div className="text-xs text-slate-500">{override.displayName}</div> : null}
                  </Td>
                  <Td className="text-right font-mono tabular-nums">{formatRate(override.inputPerM)}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatRate(override.outputPerM)}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatRate(override.cacheReadPerM)}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatRate(override.cacheWritePerM)}</Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(override.updatedAt)}</Td>
                  <Td>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => edit(override)}
                        className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(override.modelId)}
                        disabled={busy === override.modelId}
                        className="rounded border border-rose-900/70 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950/50 disabled:opacity-50"
                      >
                        撤销
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  )
}
