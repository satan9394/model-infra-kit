"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { formatDateTime, formatInt, formatMs, formatUsd, tokenTotal } from "@/lib/format"
import type { UsageEvent } from "@/lib/types"
import { Badge, EmptyState, KeyValue, TableWrap, Td, Th } from "@/components/ui"

const PAGE_SIZES = [25, 50, 100] as const

function DetailDrawer({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; event?: UsageEvent; error?: string }>({ loading: true })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await apiCall<{ event: UsageEvent }>(`/usage/logs/${encodeURIComponent(requestId)}`)
      if (cancelled) return
      setState(result.ok ? { loading: false, event: result.data.event } : { loading: false, error: result.error })
    })()
    return () => {
      cancelled = true
    }
  }, [requestId])

  const event = state.event

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="关闭" onClick={onClose} className="flex-1 bg-black/50" />
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-slate-800 bg-[#0b1120] p-4 shadow-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-slate-200">请求详情</h2>
            <p className="mt-0.5 break-all font-mono text-xs text-slate-500">{requestId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            关闭
          </button>
        </div>

        {state.loading ? <p className="text-xs text-slate-500">加载中…</p> : null}
        {state.error ? <p className="break-all font-mono text-xs text-rose-300">{state.error}</p> : null}

        {event ? (
          <div className="space-y-4">
            <section>
              <h3 className="mb-1 text-xs font-medium text-slate-400">基本信息</h3>
              <KeyValue label="时间">{formatDateTime(event.ts)}</KeyValue>
              <KeyValue label="appId">{event.appId}</KeyValue>
              <KeyValue label="来源 source">{event.source}</KeyValue>
              <KeyValue label="状态">
                <Badge tone={event.status === "ok" ? "ok" : "bad"}>{event.status}</Badge>
                {event.errorCode ? <span className="ml-2 text-rose-300">{event.errorCode}</span> : null}
              </KeyValue>
              <KeyValue label="流式">{event.isStreaming ? "是" : "否"}</KeyValue>
              <KeyValue label="供应商">{event.providerId}</KeyValue>
              <KeyValue label="请求模型">{event.modelRequested}</KeyValue>
              <KeyValue label="实际模型">{event.modelActual}</KeyValue>
              {event.sessionId ? <KeyValue label="sessionId">{event.sessionId}</KeyValue> : null}
            </section>

            <section>
              <h3 className="mb-1 text-xs font-medium text-slate-400">token（四类）</h3>
              <KeyValue label="input">{formatInt(event.usage.input)}</KeyValue>
              <KeyValue label="output">{formatInt(event.usage.output)}</KeyValue>
              <KeyValue label="cache_read">{formatInt(event.usage.cacheRead)}</KeyValue>
              <KeyValue label="cache_write">{formatInt(event.usage.cacheWrite)}</KeyValue>
              <KeyValue label="reasoning">{formatInt(event.usage.reasoning)}</KeyValue>
              <KeyValue label="合计">{formatInt(tokenTotal(event.usage))}</KeyValue>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-medium text-slate-400">成本</h3>
              <KeyValue label="usd">{formatUsd(event.cost.usd, 6)}</KeyValue>
              <KeyValue label="low / high">
                {formatUsd(event.cost.low, 6)} / {formatUsd(event.cost.high, 6)}
              </KeyValue>
              <KeyValue label="pricing_source">{event.pricingSource ?? event.cost.source}</KeyValue>
              <KeyValue label="pricing_basis">{event.pricingBasis ?? event.cost.basis}</KeyValue>
              <KeyValue label="pricing_model">{event.pricingModel ?? event.cost.pricingModel ?? "—"}</KeyValue>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-medium text-slate-400">延迟</h3>
              <KeyValue label="latency">{formatMs(event.latencyMs)}</KeyValue>
              <KeyValue label="first token">{formatMs(event.firstTokenMs)}</KeyValue>
            </section>

            {event.tags && Object.keys(event.tags).length > 0 ? (
              <section>
                <h3 className="mb-1 text-xs font-medium text-slate-400">tags</h3>
                {Object.entries(event.tags).map(([key, value]) => (
                  <KeyValue key={key} label={key}>
                    {value}
                  </KeyValue>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  )
}

export function LogsClient({
  events,
  total,
  limit,
  offset,
  baseQuery,
}: {
  events: UsageEvent[]
  total: number
  limit: number
  offset: number
  /** Current filters as a query string without `limit`/`offset`. */
  baseQuery: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const page = Math.floor(offset / Math.max(1, limit)) + 1
  const pages = Math.max(1, Math.ceil(total / Math.max(1, limit)))

  const href = (nextOffset: number, nextLimit = limit) => {
    const search = new URLSearchParams(baseQuery)
    search.set("limit", String(nextLimit))
    search.set("offset", String(Math.max(0, nextOffset)))
    return `?${search.toString()}`
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <span>
          共 <span className="font-mono text-slate-200">{formatInt(total)}</span> 条 · 第 {page} / {pages} 页 · 每页
          {PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={href(0, size)}
              className={size === limit ? "ml-2 font-mono text-sky-300" : "ml-2 font-mono text-slate-500 hover:text-slate-300"}
            >
              {size}
            </Link>
          ))}
        </span>
        <span className="flex items-center gap-2">
          <Link
            href={href(offset - limit)}
            aria-disabled={offset <= 0}
            className={
              offset <= 0
                ? "pointer-events-none rounded border border-slate-800 px-2 py-1 text-slate-600"
                : "rounded border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800"
            }
          >
            上一页
          </Link>
          <Link
            href={href(offset + limit)}
            aria-disabled={offset + limit >= total}
            className={
              offset + limit >= total
                ? "pointer-events-none rounded border border-slate-800 px-2 py-1 text-slate-600"
                : "rounded border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800"
            }
          >
            下一页
          </Link>
        </span>
      </div>

      {events.length === 0 ? (
        <EmptyState
          title="没有请求日志"
          description="该区间（或该过滤条件）下没有任何用量记录。换一个区间，或用 seed 脚本写入假数据。"
        />
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>时间</Th>
              <Th>供应商 / 模型</Th>
              <Th className="text-right">token</Th>
              <Th className="text-right">成本</Th>
              <Th className="text-right">延迟</Th>
              <Th>状态</Th>
              <Th>requestId</Th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr
                key={event.requestId}
                onClick={() => setOpenId(event.requestId)}
                className="cursor-pointer transition-colors hover:bg-slate-800/40"
              >
                <Td className="whitespace-nowrap font-mono text-xs">{formatDateTime(event.ts)}</Td>
                <Td>
                  <div className="font-mono text-xs text-slate-200">{event.modelActual || event.modelRequested}</div>
                  <div className="text-[11px] text-slate-500">{event.providerId}</div>
                </Td>
                <Td className="text-right font-mono tabular-nums text-xs">{formatInt(tokenTotal(event.usage))}</Td>
                <Td className="text-right font-mono tabular-nums text-xs">{formatUsd(event.cost.usd)}</Td>
                <Td className="text-right font-mono tabular-nums text-xs">{formatMs(event.latencyMs)}</Td>
                <Td>
                  <Badge tone={event.status === "ok" ? "ok" : "bad"}>{event.status}</Badge>
                  {event.errorCode ? <div className="mt-1 text-[11px] text-rose-400">{event.errorCode}</div> : null}
                </Td>
                <Td className="max-w-[160px] truncate font-mono text-[11px] text-slate-500">{event.requestId}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {openId ? <DetailDrawer requestId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  )
}
