"use client"

import { useI18n } from "@/lib/i18n/provider"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ErrorBanner } from "@/components/ui"

/**
 * First-run guidance for an unreachable `mik serve`.
 *
 * Order matters (EVO-G09 A1): the first block a visitor sees is this neutral,
 * informational card — not a red banner. The error-styled banner is demoted to
 * a *reaction*: it appears only after the visitor pressed "我已启动，重试" and the
 * upstream is still unreachable, so nobody reads "报错 → 解释" on first paint.
 *
 * The raw upstream message stays inside the neutral card as the diagnosis
 * (mono, subdued). `scripts/e2e/run.mjs`'s DASH checkpoint asserts on exactly
 * that text when it renders these pages against a dead upstream.
 */
export const MIK_SERVE_COMMAND = "mik serve"

export function UpstreamNotice({ message }: { message?: string }) {
  const { t } = useI18n()

  const router = useRouter()
  const [retried, setRetried] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pending, startTransition] = useTransition()

  // Upstream is healthy: render nothing at all (no empty placeholder).
  if (!message) return null

  const copy = async () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard) return
    try {
      await clipboard.writeText(MIK_SERVE_COMMAND)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const retry = () => {
    setRetried(true)
    startTransition(() => router.refresh())
  }

  return (
    <div className="mb-4">
      <section
        data-testid="upstream-guide"
        className="rounded-lg border border-info/40 bg-info/10 px-4 py-3"
      >
        <p className="text-sm font-medium text-info"> {t("s236")} <code className="font-mono">mik serve</code>
        </p>
        <p className="mt-1 text-xs leading-5 text-info/90"> {t("s237")} <code>mik serve</code> {t("s238")} </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="rounded border border-info/40 bg-surface-control px-2 py-1 font-mono text-xs text-info">
            {MIK_SERVE_COMMAND}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded border border-info/40 px-2 py-1 text-xs text-info hover:border-info hover:text-info"
          >
            {copied ? t("s239") : t("s240")}
          </button>
          <button
            type="button"
            onClick={retry}
            disabled={pending}
            className="rounded border border-info/40 px-2 py-1 text-xs text-info hover:border-info hover:text-info disabled:opacity-60"
          >
            {pending ? t("s241") : t("s242")}
          </button>
        </div>
        <p className="mt-2 break-all font-mono text-[11px] text-info/75">{message}</p>
        <p className="mt-1 text-[11px] text-info/75"> {t("s243")} <code>MIK_SERVER_URL</code> {t("s244")} <code>npm i model-infra-kit</code> {t("s245")} </p>
      </section>

      {retried && !pending ? (
        <div className="mt-3" data-testid="upstream-error">
          <ErrorBanner
            message={t(message ?? "")}
            hint={
              <> {t("s246")} <code>mik serve</code> {t("s247")} {" "}
                <code>netstat -ano | findstr :3211</code> {t("s248")} </>
            }
          />
        </div>
      ) : null}
    </div>
  )
}
