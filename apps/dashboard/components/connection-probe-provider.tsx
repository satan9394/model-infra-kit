"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { connectionAppScope, createConnectionProbe, type ProbeState } from "@/lib/connection-probe"

type ConnectionProbeContextValue = {
  state: ProbeState
  /** Scope of the authenticated dashboard that answered; `default` until a snapshot arrives. */
  appId: string
  refreshedAt: number | null
  /** Wall clock of the next scheduled read, so every countdown follows the shared cadence. */
  nextReadAt: { current: number }
  run: () => void
}

const ConnectionProbeContext = createContext<ConnectionProbeContextValue | null>(null)

const IDLE: ProbeState = { status: "pending", snapshot: null, rttMs: null }
export const CONNECTION_PROBE_INTERVAL_MS = 15_000

/**
 * One connection probe per page.
 *
 * The header's gateway pill and each page's "探测 RTT" control used to run their own
 * probe, so a single cadence cost two requests and the two readouts could disagree.
 * They now read the same measurement through this provider.
 */
export function ConnectionProbeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProbeState>(IDLE)
  const [appId, setAppId] = useState("default")
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)
  const probe = useRef<ReturnType<typeof createConnectionProbe> | null>(null)
  const nextReadAt = useRef(0)

  useEffect(() => {
    const reader = createConnectionProbe(next => {
      setState(next)
      if (next.status === "ready") {
        setAppId(connectionAppScope(next.snapshot!))
        setRefreshedAt(Date.now())
      }
    })
    probe.current = reader
    nextReadAt.current = Date.now() + CONNECTION_PROBE_INTERVAL_MS
    void reader.run()
    const cadence = setInterval(() => {
      nextReadAt.current = Date.now() + CONNECTION_PROBE_INTERVAL_MS
      if (!document.hidden) void reader.run()
    }, CONNECTION_PROBE_INTERVAL_MS)
    return () => {
      clearInterval(cadence)
      reader.dispose()
      probe.current = null
    }
  }, [])

  const run = useCallback(() => { void probe.current?.run() }, [])

  return <ConnectionProbeContext.Provider value={{ state, appId, refreshedAt, nextReadAt, run }}>{children}</ConnectionProbeContext.Provider>
}

export function useConnectionProbe() {
  const value = useContext(ConnectionProbeContext)
  if (!value) throw new Error("useConnectionProbe must be used within ConnectionProbeProvider")
  return value
}
