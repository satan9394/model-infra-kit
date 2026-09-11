"use client"

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
        className="rounded-lg border border-sky-900/70 bg-sky-950/40 px-4 py-3"
      >
        <p className="text-sm font-medium text-sky-200">
          先启动上游：<code className="font-mono">mik serve</code>
        </p>
        <p className="mt-1 text-xs leading-5 text-sky-200/80">
          看板只通过 HTTP 读 <code>mik serve</code>（默认 127.0.0.1:3211），从不打开 SQLite 文件。
          在仓库根目录先运行下面这条命令，再回来刷新本页。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="rounded border border-sky-900/70 bg-slate-950/60 px-2 py-1 font-mono text-xs text-sky-100">
            {MIK_SERVE_COMMAND}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded border border-sky-800/70 px-2 py-1 text-xs text-sky-200 hover:border-sky-700 hover:text-sky-100"
          >
            {copied ? "已复制" : "复制命令"}
          </button>
          <button
            type="button"
            onClick={retry}
            disabled={pending}
            className="rounded border border-sky-800/70 px-2 py-1 text-xs text-sky-200 hover:border-sky-700 hover:text-sky-100 disabled:opacity-60"
          >
            {pending ? "重试中…" : "我已启动，重试"}
          </button>
        </div>
        <p className="mt-2 break-all font-mono text-[11px] text-sky-200/60">{message}</p>
        <p className="mt-1 text-[11px] text-sky-200/60">
          端口不是默认值？用 <code>MIK_SERVER_URL</code> 指向你的地址。装包环境（
          <code>npm i model-infra-kit</code>）拿不到看板，见 README「看板」一节。
        </p>
      </section>

      {retried && !pending ? (
        <div className="mt-3" data-testid="upstream-error">
          <ErrorBanner
            message={message}
            hint={
              <>
                仍连不上：确认 <code>mik serve</code> 已在运行（默认 127.0.0.1:3211），再用{" "}
                <code>netstat -ano | findstr :3211</code> 核对端口。
              </>
            }
          />
        </div>
      ) : null}
    </div>
  )
}
