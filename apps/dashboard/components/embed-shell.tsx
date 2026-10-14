"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useI18n } from "@/lib/i18n/provider"
import { useTheme } from "@/components/theme-provider"
import {
  EMBED_MESSAGE,
  buildErrorMessage,
  buildReadyMessage,
  buildResizeMessage,
  embedContentSize,
  normalizeOrigin,
  validateHostMessage,
  type EmbedClientMessage,
} from "@/lib/embed-bridge"

export interface EmbedShellProps {
  /** Extra host origins allowed to talk to the embed (besides its own origin). */
  allowedOrigins?: string[]
  children: ReactNode
}

/**
 * Client half of the embed bridge (UI-202 / EVO-G145).
 *
 * Mounts the `message` listener and a `ResizeObserver` so the embed can report
 * its real height (killing the host's inner scrollbar) and mirror the host
 * theme. Every outbound frame is posted to the *negotiated* origin only — never
 * `*` — and invalid or off-allow-list messages are dropped without a reply.
 */
export function EmbedShell({ allowedOrigins = [], children }: EmbedShellProps) {
  const { t } = useI18n()
  const router = useRouter()
  const { setPreference } = useTheme()
  const allowedRef = useRef(allowedOrigins)
  allowedRef.current = allowedOrigins
  const negotiatedRef = useRef<string | null>(null)
  const [status, setStatus] = useState<"idle" | "ready" | "error">("idle")

  const postToHost = useCallback((message: EmbedClientMessage) => {
    const target = negotiatedRef.current
    if (!target || typeof window === "undefined") return
    window.parent.postMessage(message, target)
  }, [])

  const publishResize = useCallback(() => {
    const target = negotiatedRef.current
    if (!target || typeof window === "undefined") return
    const size = embedContentSize(document.documentElement, document.body)
    window.parent.postMessage(buildResizeMessage(size.height, size.width), target)
  }, [])

  useEffect(() => {
    const selfOrigin = window.location.origin
    const onMessage = (event: MessageEvent) => {
      const result = validateHostMessage(event.data, {
        origin: event.origin,
        allowedOrigins: allowedRef.current,
        selfOrigin,
        negotiatedOrigin: negotiatedRef.current,
      })
      if (!result.ok) {
        // Never bounce information back to an untrusted origin. A trusted host
        // that sent a malformed frame gets a structured code for diagnostics.
        if (result.reason !== "origin" && result.reason !== "negotiated-origin") {
          const target = normalizeOrigin(event.origin)
          // `event.source !== window` keeps an unframed page (parent === self)
          // from answering its own frames and looping on the error channel.
          if (target && event.source && event.source !== window) {
            window.parent.postMessage(buildErrorMessage(result.reason), target)
          }
        }
        if (result.reason === "origin" || result.reason === "target") setStatus("error")
        return
      }
      negotiatedRef.current = result.origin
      const message = result.message
      if (message.type === EMBED_MESSAGE.INIT) {
        if (message.theme) setPreference(message.theme)
        if (message.dateRange) {
          const url = new URL(window.location.href)
          if (url.searchParams.get("range") !== message.dateRange) {
            url.searchParams.set("range", message.dateRange)
            router.replace(`${url.pathname}?${url.searchParams.toString()}`, { scroll: false })
          }
        }
        setStatus("ready")
        postToHost(buildReadyMessage())
        publishResize()
      } else if (message.type === EMBED_MESSAGE.SET_THEME) {
        setPreference(message.theme)
        setStatus("ready")
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [postToHost, publishResize, router, setPreference])

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return
    let frame = 0
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        publishResize()
      })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(document.documentElement)
    if (document.body) observer.observe(document.body)
    window.addEventListener("resize", schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", schedule)
    }
  }, [publishResize])

  return (
    <div data-testid="embed-shell" data-embed-status={status} className="w-full">
      <span role="status" aria-live="polite" className="sr-only">
        {status === "ready" ? t("embed.bridgeReady") : status === "error" ? t("embed.bridgeError") : ""}
      </span>
      {children}
    </div>
  )
}
