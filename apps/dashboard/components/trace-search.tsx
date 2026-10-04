"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { apiCall } from "@/lib/client-api"
import { useI18n } from "@/lib/i18n/provider"
import { snippetParts } from "@/lib/search-snippet"
import type { UsageEvent } from "@/lib/types"

interface SearchHit { event: UsageEvent; score: number; snippet: string }

export function TraceSearch({ baseQuery, onOpen }: { baseQuery: string; onOpen?: (id: string) => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const [state, setState] = useState<{ loading: boolean; hits: SearchHit[]; error?: string }>({ loading: false, hits: [] })
  useEffect(() => {
    let cancelled = false
    if (!query.trim()) {
      setState({ loading: false, hits: [] })
      return
    }
    setState({ loading: true, hits: [] })
    const timer = setTimeout(() => {
      const params = new URLSearchParams(baseQuery)
      params.set("q", query)
      params.set("limit", "50")
      params.delete("offset")
      void apiCall<{ hits: SearchHit[] }>(`/usage/search?${params}`).then((result) => {
        if (cancelled) return
        setState(result.ok ? { loading: false, hits: result.data.hits } : { loading: false, hits: [], error: result.error })
      })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, baseQuery])

  return <section className="mb-4 space-y-2 rounded-xl border border-border bg-surface p-3" data-testid="trace-search">
    <label className="block text-xs text-muted-foreground">
      {t("search.label")}
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={4096}
        placeholder={t("search.placeholder")} data-testid="trace-search-input"
        className="mt-1 w-full rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-foreground" />
    </label>
    <p className="text-xs text-subtle">{t("search.scope")}</p>
    {query.trim() ? <div aria-live="polite" aria-busy={state.loading} data-testid="trace-search-results">
      {state.loading ? <p className="text-xs text-subtle">{t("s79")}</p> : state.error ? <p role="alert" className="text-xs text-danger">{state.error}</p> : <>
        <p className="text-xs text-subtle">{t("search.results", state.hits.length)}</p>
        <ul className="divide-y divide-border">{state.hits.map((hit) => <li key={hit.event.requestId} className="py-2 text-xs">
          {onOpen ? <button type="button" onClick={() => onOpen(hit.event.requestId)} className="font-mono text-info underline">{hit.event.traceId ?? hit.event.requestId}</button>
            : <Link href={`/traces?traceId=${encodeURIComponent(hit.event.traceId ?? "")}`} className="font-mono text-info underline">{hit.event.traceId ?? hit.event.requestId}</Link>}
          <span className="ml-2 text-subtle">{hit.event.providerId} / {hit.event.modelActual}</span>
          <p className="mt-1 break-all text-foreground">{snippetParts(hit.snippet).map((part, i) => part.highlighted ? <mark key={i} className="rounded bg-warning/20 text-foreground">{part.text}</mark> : <span key={i}>{part.text}</span>)}</p>
        </li>)}</ul>
      </>}
    </div> : null}
  </section>
}
