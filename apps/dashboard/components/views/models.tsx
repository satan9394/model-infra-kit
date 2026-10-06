"use client"

import { useI18n } from "@/lib/i18n/provider"
import { message } from "@/lib/i18n/core"

import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { formatInt } from "@/lib/format"
import type { CatalogModelMetadata, ModelInfo, ProviderModelBinding, ProviderRecord } from "@/lib/types"
import { Badge, Card, EmptyState, TableWrap, Td, Th } from "@/components/ui"
import { ModelCard } from "@/components/model-card"
import { ModelPingModal } from "@/components/model-ping-modal"
import { CAPABILITY_FILTERS, matchesCapabilities, type CapabilityFilter, type ModelPingResult } from "@/lib/model-capabilities"

const CAPABILITY_LABELS: ReadonlyArray<{ key: keyof ModelInfo["capabilities"]; label: string }> = [
  { key: "text", label: message("s251") },
  { key: "image", label: message("s252") },
  { key: "toolCall", label: message("s253") },
  { key: "reasoning", label: message("s254") },
  { key: "structuredOutput", label: message("s255") },
]

const selectClass =
  "rounded-md border border-border bg-surface-control px-2 py-1.5 text-xs text-foreground outline-none focus:border-border-strong"

export function ModelsClient({
  models,
  providers,
  catalogModels,
  catalogBindings,
  defaultModel,
}: {
  models: ModelInfo[]
  providers: ProviderRecord[]
  catalogModels: CatalogModelMetadata[]
  catalogBindings: ProviderModelBinding[]
  defaultModel?: string | null
}) {
  const { t } = useI18n()

  const router = useRouter()
  const [tags, setTags] = useState<CapabilityFilter[]>([])
  const [pingModel, setPingModel] = useState<string | null>(null)
  const [firstTokens, setFirstTokens] = useState<Record<string, number>>({})
  const [chosenDefault, setChosenDefault] = useState(defaultModel ?? "")
  const [provider, setProvider] = useState("")
  const [capability, setCapability] = useState("")
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return models.filter((model) => {
      if (provider && model.providerId !== provider) return false
      if (!matchesCapabilities(model, tags, firstTokens[model.ref])) return false
      if (capability && !model.capabilities[capability as keyof ModelInfo["capabilities"]]) return false
      if (!needle) return true
      return (
        model.modelId.toLowerCase().includes(needle) ||
        model.displayName.toLowerCase().includes(needle) ||
        model.ref.toLowerCase().includes(needle)
      )
    })
  }, [models, provider, capability, query, tags, firstTokens])

  const visibleCatalog = catalogModels.filter((model) => {
    if (provider && !catalogBindings.some((binding) => binding.modelId === model.id && binding.providerId === provider)) return false
    if (query.trim() && ![model.id, model.name].some((name) => name.toLowerCase().includes(query.trim().toLowerCase()))) return false
    return matchesCapabilities({ modelId: model.id, ref: model.id, contextWindow: model.contextWindow, capabilities: { text: true, image: model.capabilities.vision, toolCall: model.capabilities.tools, reasoning: model.capabilities.reasoning, structuredOutput: model.capabilities.structuredOutputs } }, tags)
  })
  async function copyRef(ref: string) {
    try { await navigator.clipboard.writeText(ref); setNotice({ tone: "ok", text: t("s256") + ref }) }
    catch { setNotice({ tone: "bad", text: t("s227") }) }
  }
  async function makeDefault(ref: string) {
    setBusy(ref)
    const result = await apiCall<{ defaultModel: string }>(`/models/${encodeURIComponent(ref)}/default`, { method: "PUT" })
    setBusy(null)
    if (result.ok) { setChosenDefault(result.data.defaultModel); setNotice({ tone: "ok", text: t("s257") + result.data.defaultModel }) }
    else setNotice({ tone: "bad", text: result.error })
  }
  function measured(result: ModelPingResult) {
    if (result.firstTokenMs !== null) setFirstTokens((current) => ({ ...current, [result.ref]: result.firstTokenMs! }))
  }

  const refresh = async (providerId: string) => {
    setBusy(providerId)
    const result = await apiCall<{ models: ModelInfo[] }>(`/providers/${encodeURIComponent(providerId)}/models/refresh`, { method: "POST" })
    setBusy(null)
    if (result.ok) {
      setNotice({ tone: "ok", text: t("s258", providerId, result.data.models.length) })
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: `${providerId}：${result.error}` })
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t("s259")}>
          {CAPABILITY_FILTERS.map(({ key, label }) => <button key={key} type="button" aria-pressed={tags.includes(key)} onClick={() => setTags((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])} className={`rounded-full border px-3 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-primary ${tags.includes(key) ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground hover:bg-surface-muted"}`}>{t(label)}</button>)}
          {tags.length > 0 ? <button onClick={() => setTags([])} className="px-2 text-xs text-subtle"> {t("s260")} </button> : null}
        </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label={t("s261")} value={provider} onChange={(event) => setProvider(event.target.value)} className={selectClass}>
              <option value=""> {t("s63")} </option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
            <select aria-label={t("s262")} value={capability} onChange={(event) => setCapability(event.target.value)} className={selectClass}>
              <option value=""> {t("s263")} </option>
              {CAPABILITY_LABELS.map((item) => (
                <option key={item.key} value={item.key}>
                  {t(item.label)}
                </option>
              ))}
            </select>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("s264")} placeholder={t("s265")}
              className={`${selectClass} w-44`}
            />
            {provider ? (
              <button
                type="button"
                onClick={() => void refresh(provider)}
                disabled={busy === provider}
                className="rounded border border-border-strong bg-surface-muted px-2 py-1.5 text-xs text-foreground hover:bg-surface-active disabled:opacity-50"
              >
                {busy === provider ? t("s158") : t("s266")}
              </button>
            ) : null}
          </div>

        <p className="mt-3 text-[10px] text-subtle"> {t("s267")} </p>
      </div>
      {pingModel ? <ModelPingModal key={pingModel} refName={pingModel} onClose={() => setPingModel(null)} onResult={measured} /> : null}
      <Card title={t("s268")} subtitle={t("s269", visibleCatalog.length, catalogModels.length)} padded={false}>
        {visibleCatalog.length === 0 ? (
          <div className="p-4">
            <EmptyState title={catalogModels.length === 0 ? t("s270") : t("s271")} description={catalogModels.length === 0 ? t("s272") : t("s273")} />
          </div>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th> {t("s274")} </Th>
                <Th> {t("s275")} </Th>
                <Th className="text-right"> {t("s276")} </Th>
                <Th className="text-right"> {t("s277")} </Th>
                <Th> {t("s278")} </Th>
                <Th> {t("s279")} </Th>
                <Th> {t("s280")} </Th>
              </tr>
            </thead>
            <tbody>
              {visibleCatalog.map((model) => (
                <tr key={model.id}>
                  <Td>
                    <div className="font-mono text-foreground">{model.id}</div>
                    <div className="text-xs text-subtle">{model.name}</div>
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">{model.family}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatInt(model.contextWindow)}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatInt(model.maxOutputTokens)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {([
                        ["reasoning", t("s254")],
                        ["vision", t("s281")],
                        ["audio", t("s282")],
                        ["tools", t("s283")],
                        ["structuredOutputs", t("s255")],
                      ] as const)
                        .filter(([key]) => Boolean(model.capabilities[key]))
                        .map(([key, label]) => (
                          <Badge key={key} tone={key === "reasoning" ? "info" : "neutral"}>
                            {t(label)}
                          </Badge>
                        ))}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {catalogBindings
                        .filter((binding) => binding.modelId === model.id)
                        .map((binding) => (
                          <Badge key={`${binding.providerId}:${binding.upstreamModelName}`} tone={binding.status === "available" ? "ok" : "warn"}>
                            {binding.providerId}/{binding.protocol}:{binding.upstreamModelName} · {t(`model.status.${binding.status}`)}
                          </Badge>
                        ))}
                    </div>
                  </Td>
                  <Td>
                    <a href={model.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-info hover:text-info">
                      {model.source}
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {notice ? (
        <div
          role="status"
          aria-live="polite"
          className={
            notice.tone === "ok"
              ? "rounded-lg border border-positive/35 bg-positive/10 px-3 py-2 text-xs text-positive"
              : "rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger"
          }
        >
          {notice.text}
        </div>
      ) : null}

      <Card
        title={t("s134")}
        subtitle={t("s284", models.length, visible.length)}
        padded={false}
      >
        {models.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={t("s285")}
              description={t("s286")}
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="p-4">
            <EmptyState title={t("s287")} description={t("s288")} />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((model) => <ModelCard key={model.ref} model={model} providerName={providers.find((item) => item.id === model.providerId)?.name ?? model.providerId} firstTokenMs={firstTokens[model.ref]} isDefault={chosenDefault === model.ref} busy={busy === model.ref} onPing={() => setPingModel(model.ref)} onCopy={() => void copyRef(model.ref)} onDefault={() => void makeDefault(model.ref)} />)}
          </div>
        )}
      </Card>
    </div>
  )
}
