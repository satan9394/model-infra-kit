"use client"

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
  { key: "text", label: "文本" },
  { key: "image", label: "图像" },
  { key: "toolCall", label: "工具调用" },
  { key: "reasoning", label: "推理" },
  { key: "structuredOutput", label: "结构化输出" },
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
    try { await navigator.clipboard.writeText(ref); setNotice({ tone: "ok", text: "已复制 / Copied: " + ref }) }
    catch { setNotice({ tone: "bad", text: "复制失败 / Copy failed" }) }
  }
  async function makeDefault(ref: string) {
    setBusy(ref)
    const result = await apiCall<{ defaultModel: string }>(`/models/${encodeURIComponent(ref)}/default`, { method: "PUT" })
    setBusy(null)
    if (result.ok) { setChosenDefault(result.data.defaultModel); setNotice({ tone: "ok", text: "默认模型 / Default: " + result.data.defaultModel }) }
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
      setNotice({ tone: "ok", text: `${providerId}：发现 ${result.data.models.length} 个模型` })
      router.refresh()
    } else {
      setNotice({ tone: "bad", text: `${providerId}：${result.error}` })
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="模型能力筛选 / Model capability filters">
          {CAPABILITY_FILTERS.map(({ key, label }) => <button key={key} type="button" aria-pressed={tags.includes(key)} onClick={() => setTags((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])} className={`rounded-full border px-3 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-primary ${tags.includes(key) ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground hover:bg-surface-muted"}`}>{label}</button>)}
          {tags.length > 0 ? <button onClick={() => setTags([])} className="px-2 text-xs text-subtle">清除标签 / Clear tags</button> : null}
        </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="供应商 / Provider" value={provider} onChange={(event) => setProvider(event.target.value)} className={selectClass}>
              <option value="">全部供应商</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
            <select aria-label="其他能力 / Other capability" value={capability} onChange={(event) => setCapability(event.target.value)} className={selectClass}>
              <option value="">全部能力</option>
              {CAPABILITY_LABELS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索模型 / Search models" placeholder="搜索 model / ref"
              className={`${selectClass} w-44`}
            />
            {provider ? (
              <button
                type="button"
                onClick={() => void refresh(provider)}
                disabled={busy === provider}
                className="rounded border border-border-strong bg-surface-muted px-2 py-1.5 text-xs text-foreground hover:bg-surface-active disabled:opacity-50"
              >
                {busy === provider ? "同步中…" : "刷新该供应商模型"}
              </button>
            ) : null}
          </div>

        <p className="mt-3 text-[10px] text-subtle">多选标签取交集 / Tags intersect. Fast 优先使用本次测速 TTFT ≤1000 ms；未测速时按轻量模型名称提示，不能保证速度 / Lightweight names are hints until measured.</p>
      </div>
      {pingModel ? <ModelPingModal key={pingModel} refName={pingModel} onClose={() => setPingModel(null)} onResult={measured} /> : null}
      <Card title="标准模型机架" subtitle={`${visibleCatalog.length} / ${catalogModels.length} 个标准模型；事实与供应商端点分别维护`} padded={false}>
        {visibleCatalog.length === 0 ? (
          <div className="p-4">
            <EmptyState title={catalogModels.length === 0 ? "内置模型机架暂不可用" : "没有匹配的标准模型"} description={catalogModels.length === 0 ? "HTTP 服务未提供 /api/catalog。" : "调整标签、供应商或搜索词 / Adjust filters."} />
          </div>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>标准模型</Th>
                <Th>家族</Th>
                <Th className="text-right">上下文</Th>
                <Th className="text-right">最大输出</Th>
                <Th>固有能力</Th>
                <Th>供应商端点</Th>
                <Th>事实来源</Th>
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
                        ["reasoning", "推理"],
                        ["vision", "视觉"],
                        ["audio", "音频"],
                        ["tools", "工具"],
                        ["structuredOutputs", "结构化输出"],
                      ] as const)
                        .filter(([key]) => Boolean(model.capabilities[key]))
                        .map(([key, label]) => (
                          <Badge key={key} tone={key === "reasoning" ? "info" : "neutral"}>
                            {label}
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
                            {binding.providerId}/{binding.protocol}:{binding.upstreamModelName} · {binding.status}
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
        title="模型目录"
        subtitle={`GET /api/models · 共 ${models.length} 条，当前显示 ${visible.length} 条`}
        padded={false}
      >
        {models.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="模型目录为空"
              description="mik 还没有发现任何模型。在「供应商」页点「刷新模型」，或运行 seed 脚本写入假目录。"
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="p-4">
            <EmptyState title="没有匹配的模型" description="换个供应商、能力或搜索词试试。" />
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
