"use client"

import { useI18n } from "@/lib/i18n/provider"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { apiCall } from "@/lib/client-api"
import { formatDateTime, formatRate } from "@/lib/format"
import type { ModelInfo, PricingOverride, PricingState } from "@/lib/types"
import { Badge, Card, EmptyState, TableWrap, Td, Th } from "@/components/ui"

const STALE_AFTER_MS = 24 * 60 * 60 * 1000

const inputClass =
  "w-full rounded-md border border-border bg-surface-control px-2 py-1.5 text-xs text-foreground outline-none focus:border-border-strong"

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
  const { t } = useI18n()

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
      setNotice({ tone: "ok", text: t("s150", result.data.state.status, result.data.state.source ?? "—") })
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
      setNotice({ tone: "bad", text: t("s151") })
      return
    }
    const body: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rates)) if (value !== undefined) body[key] = value
    if (payload.displayName.trim()) body.displayName = payload.displayName.trim()
    // S3: mik 要求至少给出一个单价，否则 400。
    if (Object.keys(body).filter((key) => key !== "displayName").length === 0) {
      setNotice({ tone: "bad", text: t("s152") })
      return
    }

    setBusy(modelId)
    const result = await apiCall(`/pricing/${encodeURIComponent(modelId)}`, { method: "PUT", body })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: t("s153", modelId) })
      setForm(EMPTY_FORM)
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: result.error })
    }
  }

  const remove = async (modelId: string) => {
    if (!window.confirm(t("s154", modelId))) return
    setBusy(modelId)
    const result = await apiCall(`/pricing/${encodeURIComponent(modelId)}`, { method: "DELETE" })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: t("s155", modelId) })
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
    setNotice({ tone: "ok", text: t("s156", override.modelId) })
  }

  return (
    <div className="space-y-4">
      {notice ? (
        <div
          className={
            notice.tone === "ok"
              ? "rounded-lg border border-positive/35 bg-positive/10 px-3 py-2 text-xs text-positive"
              : "rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger"
          }
        >
          {t(notice.text)}
        </div>
      ) : null}

      <Card
        title={t("s157")}
        subtitle="GET /api/pricing"
        actions={
          <button
            type="button"
            onClick={() => void sync()}
            disabled={busy === "__sync__"}
            className="rounded border border-border-strong bg-surface-muted px-3 py-1.5 text-xs text-foreground hover:bg-surface-active disabled:opacity-50"
          >
            {busy === "__sync__" ? t("s158") : t("s159")}
          </button>
        }
      >
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Badge tone={state?.status === "fresh" ? "ok" : state?.status === "stale" ? "warn" : state?.status === "error" ? "bad" : "muted"}>
            {state?.status ?? t("s160")}
          </Badge>
          <span> {t("s161")} {state?.source ?? "—"}</span>
          <span> {t("s162")} {formatDateTime(state?.loadedAt)}</span>
          {stale ? (
            <span className="rounded border border-warning/35 bg-warning/10 px-2 py-0.5 text-warning"> {t("s163")} </span>
          ) : null}
        </div>
        {state?.lastError ? (
          <p className="mt-2 break-all font-mono text-xs text-danger"> {t("s164")} {state.lastError}</p>
        ) : null}
        <p className="mt-2 text-[11px] text-subtle"> {t("s165")} </p>
      </Card>

      <Card
        title={form.modelId ? t("s166", form.modelId) : t("s167")}
        subtitle={t("s168")}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs text-subtle"> {t("s169")} <input
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
          <label className="text-xs text-subtle"> {t("s170")} <input className={inputClass} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
          </label>
          <label className="text-xs text-subtle">
            input / 1M（USD）
            <input className={inputClass} value={form.inputPerM} onChange={(event) => setForm({ ...form, inputPerM: event.target.value })} placeholder="0.27" />
          </label>
          <label className="text-xs text-subtle">
            output / 1M（USD）
            <input className={inputClass} value={form.outputPerM} onChange={(event) => setForm({ ...form, outputPerM: event.target.value })} placeholder="1.10" />
          </label>
          <label className="text-xs text-subtle">
            cache_read / 1M（USD）
            <input className={inputClass} value={form.cacheReadPerM} onChange={(event) => setForm({ ...form, cacheReadPerM: event.target.value })} />
          </label>
          <label className="text-xs text-subtle">
            cache_write / 1M（USD）
            <input className={inputClass} value={form.cacheWritePerM} onChange={(event) => setForm({ ...form, cacheWritePerM: event.target.value })} />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => void save(form.modelId.trim(), form)}
            disabled={busy === form.modelId || !form.modelId.trim()}
            className="rounded-md border border-border-strong bg-surface-muted px-3 py-1.5 text-xs text-foreground hover:bg-surface-active disabled:opacity-50"
          >
            {busy === form.modelId ? t("s54") : t("s171")}
          </button>
          <button
            type="button"
            onClick={() => setForm(EMPTY_FORM)}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-muted hover:text-foreground"
          > {t("s172")} </button>
        </div>
      </Card>

      <Card title={t("s173", overrides.length)} subtitle={t("s174")} padded={false}>
        {overrides.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={t("s175")}
              description={t("s176")}
            />
          </div>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th> {t("s177")} </Th>
                <Th className="text-right">input / 1M</Th>
                <Th className="text-right">output / 1M</Th>
                <Th className="text-right">cache_read / 1M</Th>
                <Th className="text-right">cache_write / 1M</Th>
                <Th> {t("s178")} </Th>
                <Th> {t("s179")} </Th>
              </tr>
            </thead>
            <tbody>
              {overrides.map((override) => (
                <tr key={override.modelId}>
                  <Td>
                    <div className="font-mono text-foreground">{override.modelId}</div>
                    {override.displayName ? <div className="text-xs text-subtle">{override.displayName}</div> : null}
                  </Td>
                  <Td className="text-right font-mono tabular-nums">{formatRate(override.inputPerM)}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatRate(override.outputPerM)}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatRate(override.cacheReadPerM)}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatRate(override.cacheWritePerM)}</Td>
                  <Td className="text-xs text-subtle">{formatDateTime(override.updatedAt)}</Td>
                  <Td>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => edit(override)}
                        className="rounded border border-border-strong px-2 py-1 text-[11px] text-foreground/80 hover:bg-surface-muted"
                      > {t("s180")} </button>
                      <button
                        type="button"
                        onClick={() => void remove(override.modelId)}
                        disabled={busy === override.modelId}
                        className="rounded border border-danger/35 px-2 py-1 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
                      > {t("s181")} </button>
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
