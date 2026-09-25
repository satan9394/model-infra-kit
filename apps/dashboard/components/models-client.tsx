"use client"

import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { formatDateTime, formatInt, formatRate } from "@/lib/format"
import type { CatalogModelMetadata, ModelInfo, ProviderModelBinding, ProviderRecord } from "@/lib/types"
import { Badge, Card, EmptyState, TableWrap, Td, Th } from "@/components/ui"

const CAPABILITY_LABELS: ReadonlyArray<{ key: keyof ModelInfo["capabilities"]; label: string }> = [
  { key: "text", label: "文本" },
  { key: "image", label: "图像" },
  { key: "toolCall", label: "工具调用" },
  { key: "reasoning", label: "推理" },
  { key: "structuredOutput", label: "结构化输出" },
]

const SOURCE_TONE: Record<string, "info" | "ok" | "warn" | "muted"> = {
  provider_api: "info",
  models_dev: "ok",
  preset: "warn",
  manual: "muted",
}

const selectClass =
  "rounded-md border border-border bg-surface-control px-2 py-1.5 text-xs text-foreground outline-none focus:border-border-strong"

export function ModelsClient({
  models,
  providers,
  catalogModels,
  catalogBindings,
}: {
  models: ModelInfo[]
  providers: ProviderRecord[]
  catalogModels: CatalogModelMetadata[]
  catalogBindings: ProviderModelBinding[]
}) {
  const router = useRouter()
  const [provider, setProvider] = useState("")
  const [capability, setCapability] = useState("")
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return models.filter((model) => {
      if (provider && model.providerId !== provider) return false
      if (capability && !model.capabilities[capability as keyof ModelInfo["capabilities"]]) return false
      if (!needle) return true
      return (
        model.modelId.toLowerCase().includes(needle) ||
        model.displayName.toLowerCase().includes(needle) ||
        model.ref.toLowerCase().includes(needle)
      )
    })
  }, [models, provider, capability, query])

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
      <Card title="标准模型机架" subtitle={`${catalogModels.length} 个标准模型；事实与供应商端点分别维护`} padded={false}>
        {catalogModels.length === 0 ? (
          <div className="p-4">
            <EmptyState title="内置模型机架暂不可用" description="HTTP 服务未提供 /api/catalog。" />
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
              {catalogModels.map((model) => (
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
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select value={provider} onChange={(event) => setProvider(event.target.value)} className={selectClass}>
              <option value="">全部供应商</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
            <select value={capability} onChange={(event) => setCapability(event.target.value)} className={selectClass}>
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
              placeholder="搜索 model / ref"
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
        }
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
          <TableWrap>
            <thead>
              <tr>
                <Th>模型</Th>
                <Th>供应商</Th>
                <Th className="text-right">上下文</Th>
                <Th className="text-right">最大输出</Th>
                <Th>能力</Th>
                <Th className="text-right">价格 / 1M（in / out / 读缓存 / 写缓存）</Th>
                <Th>来源</Th>
                <Th>同步时间</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((model) => (
                <tr key={model.ref}>
                  <Td>
                    <div className="font-mono text-foreground">{model.modelId}</div>
                    <div className="text-xs text-subtle">{model.displayName}</div>
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">{model.providerId}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatInt(model.contextWindow)}</Td>
                  <Td className="text-right font-mono tabular-nums">{formatInt(model.maxOutputTokens)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {CAPABILITY_LABELS.filter((item) => model.capabilities[item.key]).map((item) => (
                        <Badge key={item.key} tone={item.key === "reasoning" ? "info" : "neutral"}>
                          {item.label}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-xs">
                    {model.pricing
                      ? `${formatRate(model.pricing.inputPerM)} / ${formatRate(model.pricing.outputPerM)} / ${formatRate(model.pricing.cacheReadPerM)} / ${formatRate(model.pricing.cacheWritePerM)}`
                      : "—"}
                  </Td>
                  <Td>
                    <Badge tone={SOURCE_TONE[model.source] ?? "muted"}>{model.source}</Badge>
                  </Td>
                  <Td className="text-xs text-subtle">{model.syncedAt ? formatDateTime(model.syncedAt) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  )
}
