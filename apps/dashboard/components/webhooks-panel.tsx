"use client"

import { useEffect, useRef, useState } from "react"
import { apiCall } from "@/lib/client-api"
import { useI18n } from "@/lib/i18n/provider"
import { Card } from "@/components/ui"
import type { WebhookOutboxStats, WebhookStatus } from "model-infra-kit"

export function WebhooksPanel() {
  const { t } = useI18n()
  const [data, setData] = useState<WebhookStatus | null>(null)
  const [outbox, setOutbox] = useState<WebhookOutboxStats | null>(null)
  const [failed, setFailed] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<"queued" | "failed" | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [retryMessage, setRetryMessage] = useState<string | null>(null)
  const testController = useRef<AbortController | null>(null)
  const retryController = useRef<AbortController | null>(null)
  useEffect(() => {
    let active = true, pending = false
    const controller = new AbortController()
    async function load() {
      if (pending) return
      pending = true
      // The queue read is best-effort: a server without the durable outbox
      // endpoint must still render the delivery monitor, not fail the page.
      const [status, stats] = await Promise.all([
        apiCall<WebhookStatus>("/webhooks/status", { signal: controller.signal }),
        apiCall<WebhookOutboxStats>("/webhooks/outbox/stats", { signal: controller.signal }),
      ])
      pending = false
      if (!active) return
      setFailed(!status.ok)
      setData(status.ok ? status.data : null)
      setOutbox(stats.ok ? stats.data : null)
    }
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 5000)
    return () => { active = false; controller.abort(); testController.current?.abort(); retryController.current?.abort(); clearInterval(timer) }
  }, [])
  async function test() {
    if (testController.current) return
    const controller = new AbortController()
    testController.current = controller
    setTesting(true)
    const result = await apiCall<{ accepted: boolean }>("/webhooks/test", { method: "POST", signal: controller.signal })
    if (controller.signal.aborted) return
    setTesting(false)
    testController.current = null
    setTestResult(result.ok && result.data.accepted ? "queued" : "failed")
  }
  async function retryDeadLetters() {
    if (retryController.current || outbox?.mode !== "durable") return
    const controller = new AbortController()
    retryController.current = controller
    setRetrying(true)
    setRetryMessage(null)
    const result = await apiCall<{ mode: "durable" | "memory"; requeued: number }>("/webhooks/outbox/retry-dead", { method: "POST", signal: controller.signal })
    if (controller.signal.aborted) return
    setRetrying(false)
    retryController.current = null
    setRetryMessage(result.ok ? t("webhooks.outboxRetryShown", String(result.data.requeued)) : t("webhooks.outboxUnavailable"))
  }
  // In durable mode the in-memory counters are always zero and the in-memory
  // dead-letter list is always empty, so the outbox card below is the one
  // authoritative view. Showing both would print "Delivered 0" and
  // "No failed deliveries." right next to the real queue numbers.
  const durable = outbox?.mode === "durable"
  return <div data-testid="webhook-monitor">
    <Card title={t("webhooks.title")} subtitle={t("webhooks.configuration")}>
      <section className="mb-5 rounded-xl border border-border bg-surface-muted/50 p-3" data-testid="webhook-semantic-note">
        <h3 className="text-xs font-medium text-foreground">{t("webhooks.semanticsTitle")}</h3>
        <p className="mt-1 text-xs leading-5 text-subtle">{durable ? t("webhooks.semanticsBodyDurable") : t("webhooks.semanticsBody")}</p>
      </section>
      <section className="mb-5 rounded-xl border border-border p-3" data-testid="webhook-outbox-status">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium text-foreground">{t("webhooks.outboxTitle")}</h3>
          {outbox ? <p className="font-mono text-xs text-subtle" data-testid="webhook-outbox-mode">
            {durable ? t("webhooks.outboxModeDurable") : t("webhooks.outboxModeMemory")}
          </p> : <p role="status" className="text-xs text-subtle">{t("webhooks.outboxUnavailable")}</p>}
        </div>
        {outbox ? <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5" data-testid="webhook-outbox-counters">
          {([
            ["webhooks.outboxPending", outbox.pending],
            ["webhooks.outboxProcessing", outbox.processing],
            ["webhooks.outboxDelivered", outbox.delivered],
            ["webhooks.outboxDeadLetters", outbox.deadLetter],
            ["webhooks.dropped", outbox.dropped],
          ] as const).map(([key, value]) => <div key={key}>
            <dt className="text-subtle">{t(key)}</dt><dd className="font-mono tabular-nums">{value}</dd>
          </div>)}
        </dl> : null}
        <button type="button" disabled={retrying || !durable || (outbox?.deadLetter ?? 0) === 0} onClick={() => void retryDeadLetters()}
          className="mt-3 rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">{t("webhooks.outboxRetry")}</button>
        {!durable && outbox ? <p role="status" className="mt-2 text-xs text-subtle">{t("webhooks.outboxRetryMemoryOnly")}</p> : null}
        <p role="status" aria-live="polite" className="mt-2 text-sm">{retryMessage ?? ""}</p>
      </section>
      {failed ? <p role="status">{t("webhooks.unavailable")}</p> : !data ? <p role="status">{t("webhooks.loading")}</p> : <>
        {!data.endpoints.length ? <p className="text-sm text-subtle">{t("webhooks.empty")}</p> : <ul className="space-y-3">
          {data.endpoints.map(endpoint => <li key={endpoint.index} className="rounded-xl border border-border p-3 text-sm">
            <p>{t("webhooks.endpoint")} {endpoint.index + 1}</p>
            <p className="break-all font-mono text-xs text-subtle">{endpoint.events.join(" · ")}</p>
            <p className="mt-1 text-xs">{t("webhooks.timeout")}: {endpoint.timeoutMs}ms · {t("webhooks.retries")}: {endpoint.maxRetries}</p>
          </li>)}
        </ul>}
        {!durable ? <dl className="my-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3" data-testid="webhook-counters">
          {(["queued", "active", "retrying", "delivered", "dropped"] as const).map(key => <div key={key}>
            <dt className="text-subtle">{t(`webhooks.${key}`)}</dt><dd className="font-mono tabular-nums">{data[key]}</dd>
          </div>)}
        </dl> : null}
        <button type="button" disabled={testing || data.closed || !data.endpoints.length} onClick={() => void test()} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">{t("webhooks.test")}</button>
        <p role="status" aria-live="polite" className="mt-2 text-sm">{testResult ? t(testResult === "queued" ? "webhooks.testQueued" : "webhooks.testFailed") : ""}</p>
        {!durable ? <>
          <h3 className="mt-6 text-sm font-medium">{t("webhooks.deadLetters")}</h3>
          {!data.deadLetters.length ? <p className="mt-2 text-sm text-subtle">{t("webhooks.noFailures")}</p> : <ul className="mt-2 divide-y divide-border" data-testid="webhook-dead-letters">
            {data.deadLetters.map(entry => <li key={`${entry.endpoint}:${entry.eventId}`} className="min-w-0 py-3">
              <details className="min-w-0">
                <summary data-testid="webhook-dead-letter-summary" className="cursor-pointer break-all font-mono text-xs text-foreground">
                  {entry.type} · {t("webhooks.attempts")}: {entry.attempts} · {entry.eventId}
                </summary>
                <div className="mt-2 min-w-0 rounded-lg border border-border bg-surface-muted/50 p-3 text-xs">
                  <dl className="min-w-0 space-y-1">
                    <div className="flex min-w-0 gap-2"><dt className="shrink-0 text-subtle">{t("webhooks.endpoint")}</dt><dd className="break-all font-mono">{entry.endpoint + 1}</dd></div>
                    <div className="flex min-w-0 gap-2"><dt className="shrink-0 text-subtle">{t("webhooks.attempts")}</dt><dd className="font-mono tabular-nums">{entry.attempts}</dd></div>
                    <div className="min-w-0"><dt className="text-subtle">{t("webhooks.deadLetterError")}</dt><dd data-testid="webhook-dead-letter-error" className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-surface p-2 font-mono [overflow-wrap:anywhere]">{entry.error}</dd></div>
                  </dl>
                  <p className="mt-2 text-subtle">{t("webhooks.timestampUnavailable")}</p>
                </div>
              </details>
            </li>)}
          </ul>}
        </> : null}
      </>}
    </Card>
  </div>
}
