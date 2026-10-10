export interface EndpointQoSStats {
  providerId: string
  modelId: string
  sampleCount: number
  ewmaRttMs: number
  /** null until a streaming first-output measurement exists. */
  ewmaTtftMs: number | null
  /** Standard deviation in ms; variance is reported separately in ms². */
  jitterMs: number
  jitterVarianceMs2: number
  consecutiveFailures: number
  successRate: number
  qosScore: number
  effectiveWeight: number
  lastUpdated: number
}

interface Window {
  baseWeight: number
  stats: EndpointQoSStats
  rtts: Float64Array
  successes: Uint8Array
  cursor: number
  size: number
  sum: number
  sumSquares: number
  successCount: number
}

export function qosScore(rtt: number, jitter: number, successRate: number, failures: number, baselineRttMs = 100): number {
  return Math.max(5, Math.min(100, Math.round(100 - Math.min(50, rtt / baselineRttMs * 15)
    - Math.min(20, jitter / 100 * 10) - (1 - successRate) * 50 - failures * 15)))
}

/** O(1) fixed-size ring updates. No timers, transport, storage or error strings. */
export class QoSTracker {
  private readonly channels = new Map<string, Map<string, Window>>()
  private readonly windowSize: number
  private readonly baselineRttMs: number
  constructor(windowSize = 32, baselineRttMs = 100) {
    if (!Number.isSafeInteger(windowSize) || windowSize < 1 || windowSize > 4096 || !Number.isFinite(baselineRttMs) || baselineRttMs <= 0) {
      throw new Error("Invalid QoS window or baseline.")
    }
    this.windowSize = windowSize
    this.baselineRttMs = baselineRttMs
  }
  private channel(providerId: string, modelId: string): Window {
    let models = this.channels.get(providerId)
    if (!models) { models = new Map(); this.channels.set(providerId, models) }
    let entry = models.get(modelId)
    if (!entry) {
      entry = { baseWeight: 100, stats: { providerId, modelId, sampleCount: 0, ewmaRttMs: 0, ewmaTtftMs: null, jitterMs: 0,
        jitterVarianceMs2: 0, consecutiveFailures: 0, successRate: 1, qosScore: 100, effectiveWeight: 100, lastUpdated: 0 },
        rtts: new Float64Array(this.windowSize), successes: new Uint8Array(this.windowSize), cursor: 0, size: 0, sum: 0, sumSquares: 0, successCount: 0 }
      models.set(modelId, entry)
    }
    return entry
  }
  /** Register configured channels before the request hot path. */
  register(providerId: string, modelId: string, baseWeight = 100): void {
    if (!Number.isSafeInteger(baseWeight) || baseWeight < 1 || baseWeight > 1_000_000) throw new Error("Invalid QoS weight.")
    const w = this.channel(providerId, modelId)
    w.baseWeight = baseWeight
    w.stats.effectiveWeight = this.weight(providerId, modelId, baseWeight)
  }
  record(providerId: string, modelId: string, rttMs: number, success: boolean, ttftMs?: number, at = Date.now()): void {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 86_400_000 || !Number.isFinite(at)
      || (ttftMs !== undefined && (!Number.isFinite(ttftMs) || ttftMs < 0 || ttftMs > rttMs))) throw new Error("Invalid QoS sample.")
    const w = this.channel(providerId, modelId)
    const s = w.stats
    const old = w.rtts[w.cursor]!
    w.sum += rttMs - old
    w.sumSquares += rttMs * rttMs - old * old
    w.successCount += Number(success) - w.successes[w.cursor]!
    w.rtts[w.cursor] = rttMs
    w.successes[w.cursor] = Number(success)
    w.cursor = (w.cursor + 1) % this.windowSize
    w.size = Math.min(this.windowSize, w.size + 1)
    s.ewmaRttMs = s.sampleCount ? s.ewmaRttMs + 0.2 * (rttMs - s.ewmaRttMs) : rttMs
    if (ttftMs !== undefined) s.ewmaTtftMs = s.ewmaTtftMs === null ? ttftMs : s.ewmaTtftMs + 0.2 * (ttftMs - s.ewmaTtftMs)
    s.sampleCount += 1
    s.jitterVarianceMs2 = Math.max(0, w.sumSquares / w.size - (w.sum / w.size) ** 2)
    s.jitterMs = Math.sqrt(s.jitterVarianceMs2)
    s.consecutiveFailures = success ? 0 : s.consecutiveFailures + 1
    s.successRate = w.successCount / w.size
    s.qosScore = qosScore(Math.max(s.ewmaRttMs, s.ewmaTtftMs ?? 0), s.jitterMs, s.successRate, s.consecutiveFailures, this.baselineRttMs)
    s.lastUpdated = at
    s.effectiveWeight = Math.max(1, Math.round(w.baseWeight * s.qosScore / 100))
  }
  weight(providerId: string, modelId: string, baseWeight = 100): number {
    return Math.max(1, Math.round(baseWeight * (this.channels.get(providerId)?.get(modelId)?.stats.qosScore ?? 100) / 100))
  }
  has(providerId: string, modelId: string): boolean {
    return this.channels.get(providerId)?.has(modelId) ?? false
  }
  snapshot(): EndpointQoSStats[] {
    return [...this.channels.values()].flatMap(models => [...models.values()].map(w => ({ ...w.stats })))
  }
}
