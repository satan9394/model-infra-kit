export interface ConnectionSnapshot {
  appId?: string
  authenticated?: boolean
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

export function connectionAppScope(snapshot: ConnectionSnapshot): string {
  return snapshot.authenticated ? snapshot.appId ?? "default" : "default"
}

const PROBE_URL = "/api/mik/connections"

export interface ResourceEntryTiming { startTime: number; duration: number }

/**
 * Newest entry at or after the dispatch mark, so an earlier probe's entry is never
 * mistaken for this request. `-1` tolerates the reduced resolution of both clocks.
 */
export function pickResourceDuration(entries: ArrayLike<ResourceEntryTiming>, since: number): number | null {
  let newest: ResourceEntryTiming | null = null
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.startTime < since - 1 || !Number.isFinite(entry.duration)) continue
    if (!newest || entry.startTime >= newest.startTime) newest = entry
  }
  return newest ? Math.max(0, Math.round(newest.duration)) : null
}

/**
 * The browser's own timing for the request: a wall clock also bills main-thread stalls,
 * which during hydration read several times the real round trip. Null when unavailable.
 */
export function readResourceDuration(url: string, since: number): number | null {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") return null
    const base = typeof location === "undefined" ? undefined : location.href
    return pickResourceDuration(performance.getEntriesByName(new URL(url, base).href) as ArrayLike<ResourceEntryTiming>, since)
  } catch {
    return null
  }
}

/** Latest probe wins; disposal/aborts never publish stale network results. */
export function createConnectionProbe(
  publish: (state: ProbeState) => void,
  fetcher: typeof fetch = fetch,
  now: () => number = () => performance.now(),
  resourceDuration: (url: string, since: number) => number | null = readResourceDuration,
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
      const timeout = setTimeout(() => current.abort(), 10_000)
      publish({ status: "pending", snapshot: null, rttMs: null })
      try {
        // The mark is taken after the pending state is published: reading the clock first
        // billed our own state update to the round trip, which the regression test guards.
        const dispatchedAt = now()
        const response = await fetcher(PROBE_URL, { cache: "no-store", signal: current.signal })
        if (!response.ok) throw new Error("Connection probe failed")
        const snapshot: ConnectionSnapshot = await response.json()
        if ((snapshot.appId !== undefined && typeof snapshot.appId !== "string") || (snapshot.authenticated !== undefined && typeof snapshot.authenticated !== "boolean") || !Number.isSafeInteger(snapshot.requests) || snapshot.requests < 0 || !Number.isSafeInteger(snapshot.events)
          || snapshot.events < 0 || snapshot.active !== snapshot.requests + snapshot.events || !Array.isArray(snapshot.connections)
          || snapshot.connections.some(entry => !Number.isFinite(entry.startedAt) || typeof entry.model !== "string")) {
          throw new Error("Invalid connection snapshot")
        }
        if (!disposed && request === sequence && !current.signal.aborted) {
          // Prefer the browser's measurement; the wall clock is only the fallback.
          const rttMs = resourceDuration(PROBE_URL, dispatchedAt) ?? Math.round(now() - dispatchedAt)
          publish({ status: "ready", snapshot, rttMs })
        }
      } catch {
        if (!disposed && request === sequence) publish({ status: "offline", snapshot: null, rttMs: null })
      } finally { clearTimeout(timeout) }
    },
    dispose(): void { disposed = true; sequence++; controller?.abort() },
  }
}
