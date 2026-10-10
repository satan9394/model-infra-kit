"use client"

import { useEffect, useState } from "react"
import { apiCall } from "./client-api"

export interface EndpointQoSStats {
  providerId: string
  modelId: string
  sampleCount: number
  ewmaRttMs: number
  ewmaTtftMs: number | null
  jitterMs: number
  jitterVarianceMs2: number
  consecutiveFailures: number
  successRate: number
  qosScore: number
  effectiveWeight: number
  lastUpdated: number
}

/** One poll per view, never one per card. Keep credentials in the existing proxy. */
export function useQoS() {
  const [channels, setChannels] = useState<EndpointQoSStats[]>([])
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const result = await apiCall<{ channels: EndpointQoSStats[] }>("/providers/qos", { signal: abort.signal })
      if (abort.signal.aborted) return
      setUnavailable(!result.ok)
      if (result.ok) setChannels(result.data.channels)
      timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [])
  return { channels, unavailable }
}
