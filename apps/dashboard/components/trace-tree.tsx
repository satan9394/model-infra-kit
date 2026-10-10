"use client"

import { useRef, useState } from "react"
import { useI18n } from "@/lib/i18n/provider"
import { formatInt, formatMs } from "@/lib/format"
import type { TraceTreeNode } from "@/lib/types"

const colors = { root: "text-slate-500", reasoning: "text-purple-500", tool_call: "text-blue-500", generation: "text-emerald-500" }

export function StepCostInspector({ node, onClose }: { node: TraceTreeNode; onClose: () => void }) {
  const { t } = useI18n()
  return <aside role="dialog" aria-modal="false" aria-label={t("tree.inspector")} data-testid="step-cost-inspector"
    onKeyDown={event => { if (event.key === "Escape") onClose() }}
    className="fixed inset-y-0 right-0 z-50 w-full max-w-sm overflow-y-auto border-l border-border bg-surface p-5 shadow-xl">
    <button autoFocus onClick={onClose} className="mb-4 rounded border border-border px-3 py-2">{t("tree.close")}</button>
    <h2 className="font-semibold">{t("tree.inspector")}</h2>
    <p className="my-3 break-all font-mono text-xs">{node.toolName ?? node.spanId}</p>
    <dl className="space-y-3 text-sm">
      {[
        [t("tree.duration"), formatMs(node.stepDurationMs ?? node.durationMs)], [t("tree.firstToken"), formatMs(node.firstTokenMs)],
        [t("tree.cost"), formatInt(node.stepCostMicros)], [t("tree.savings"), formatInt(node.stepCacheSavingsMicros)],
        [t("tree.input"), formatInt(node.usage.input)], [t("tree.output"), formatInt(node.usage.output)],
        [t("tree.cacheRead"), formatInt(node.usage.cacheRead)], [t("tree.cacheWrite"), formatInt(node.usage.cacheWrite)],
        [t("tree.reasoningTokens"), formatInt(node.usage.reasoning)],
      ].map(([label, value]) => <div key={label}><dt className="text-subtle">{label}</dt><dd className="font-mono">{value}</dd></div>)}
    </dl>
    {node.cascadingTier && <p className="mt-4" data-testid="step-cascading-tier">{t(node.cascadingTier === "tier1" ? "cascade.tier1" : "cascade.tier2")}{node.cascadingEscalated ? ` · ${t("cascade.escalated")}` : ""}</p>}
  </aside>
}

export function TraceTreeView({ tree }: { tree: TraceTreeNode }) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<TraceTreeNode | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  function renderNode(node: TraceTreeNode, key: string) {
    const label = node.toolName ?? node.spanId
    const left = tree.durationMs ? Math.min(100, Math.max(0, node.startOffsetMs / tree.durationMs * 100)) : 0
    const width = tree.durationMs ? Math.min(100 - left, node.durationMs / tree.durationMs * 100) : 0
    return <li key={key}>
      <details open className="my-1 rounded border border-border p-2" data-testid="trace-tree-node">
        <summary className={`cursor-pointer text-xs ${colors[node.spanType]}`}>
          {t(`tree.${node.spanType}`)} · <span className="break-all font-mono">{label}</span> · {formatMs(node.durationMs)} · {formatInt(node.stepCostMicros)} µUSD
        </summary>
        <div className="relative my-2 h-2 rounded bg-surface-muted" aria-hidden="true"><span className="absolute h-full rounded bg-current" style={{ left: `${left}%`, width: `${width}%`, color: node.spanType === "tool_call" ? "#3b82f6" : node.spanType === "reasoning" ? "#a855f7" : node.spanType === "generation" ? "#10b981" : "#64748b" }} /></div>
        <button className="rounded border border-border px-2 py-1 text-xs" aria-label={`${t("tree.inspect")}: ${label}`} onClick={event => { trigger.current = event.currentTarget; setSelected(node) }}>{t("tree.inspect")}</button>
        {node.children.length > 0 && <ul className="ml-3 border-l border-border pl-2">{node.children.map((child, i) => renderNode(child, `${key}-${i}`))}</ul>}
      </details>
    </li>
  }
  return <section data-testid="trace-execution-tree" aria-label={t("tree.title")} className="mb-4">
    <h3 className="text-sm font-semibold">{t("tree.title")} · {t("tree.total")}: {formatInt(tree.totalCostMicros)}</h3>
    <p className="my-2 text-xs text-subtle">{t("tree.policy")}</p>
    <ul>{renderNode(tree, "root")}</ul>
    {selected && <StepCostInspector node={selected} onClose={() => { setSelected(null); trigger.current?.focus() }} />}
  </section>
}
