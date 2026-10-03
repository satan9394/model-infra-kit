export interface ConnectionSnapshot {
  active: number
  requests: number
  events: number
  connections: Array<{ id: string; kind: "chat" | "events"; startedAt: number; model: string }>
}
export interface ProbeState {
  status: "pending" | "ready" | "offline"
  snapshot: ConnectionSnapshot | null
  rttMs: number | null
}

/** Latest probe wins; disposal/aborts never publish stale network results. */
export function createConnectionProbe(
  publish: (state: ProbeState) => void,
  fetcher: typeof fetch = fetch,
  now: () => number = () => performance.now(),
) {
  let controller: AbortController | undefined
  let sequence = 0
  let disposed = false
  return {
    async run(): Promise<void> {
      if (disposed) return
      controller?.abort()
      const current = new AbortController()
      controller = current
      const request = ++sequence
      const started = now()
      const timeout = setTimeout(() => current.abort(), 10_000)
      publish({ status: "pending", snapshot: null, rttMs: null })
      try {
        const response = await fetcher("/api/mik/connections", { cache: "no-store", signal: current.signal })
        if (!response.ok) throw new Error("Connection probe failed")
        const snapshot: ConnectionSnapshot = await response.json()
        if (!Number.isSafeInteger(snapshot.requests) || snapshot.requests < 0 || !Number.isSafeInteger(snapshot.events)
          || snapshot.events < 0 || snapshot.active !== snapshot.requests + snapshot.events || !Array.isArray(snapshot.connections)
          || snapshot.connections.some(entry => !Number.isFinite(entry.startedAt) || typeof entry.model !== "string")) {
          throw new Error("Invalid connection snapshot")
        }
        if (!disposed && request === sequence && !current.signal.aborted) {
          publish({ status: "ready", snapshot, rttMs: Math.round(now() - started) })
        }
      } catch {
        if (!disposed && request === sequence) publish({ status: "offline", snapshot: null, rttMs: null })
      } finally { clearTimeout(timeout) }
    },
    dispose(): void { disposed = true; sequence++; controller?.abort() },
  }
}
