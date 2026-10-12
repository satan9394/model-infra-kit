export interface TenantQuotaConfig {
  orgId?: string
  appId: string
  maxRpm?: number
  maxTpm?: number
  monthlyHardCapMicros?: bigint
  dailyHardCapMicros?: bigint
}

export interface RateLimitCheckResult {
  allowed: boolean
  retryAfterSeconds?: number
  currentRpm: number
  limitRpm?: number
  currentTpm: number
  limitTpm?: number
  reason?: "RPM_EXCEEDED" | "TPM_EXCEEDED" | "ORG_BUDGET_EXCEEDED" | "APP_BUDGET_EXCEEDED"
}

/** Exact trailing-minute reservations, not fixed-minute counters or burst refill.
 * Synchronous probe/consume has no await or external lock. One ring entry per
 * accepted request; a Fenwick index and binary timestamp expiry bound even
 * denied/full-window expiry work to O(log capacity), with no full-ring scan.
 */
export class RateLimiter {
  private readonly times: Float64Array
  private readonly tokens: Float64Array
  private readonly sums: Float64Array
  private head = 0
  private count = 0
  private total = 0
  private last = 0
  readonly maxRpm?: number
  readonly maxTpm?: number
  private readonly clock: () => number

  constructor(config: Pick<TenantQuotaConfig, "maxRpm" | "maxTpm">, clock = () => performance.now()) {
    this.clock = clock
    for (const limit of [config.maxRpm, config.maxTpm]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000)) throw new TypeError("Rate limits must be integers from 1 to 100000.")
    }
    this.maxRpm = config.maxRpm
    this.maxTpm = config.maxTpm
    const capacity = Math.min(config.maxRpm ?? Infinity, config.maxTpm ?? Infinity)
    this.times = new Float64Array(Number.isFinite(capacity) ? capacity : 0)
    this.tokens = new Float64Array(this.times.length)
    this.sums = new Float64Array(this.times.length + 1)
  }

  private prefix(end: number): number {
    let sum = 0
    for (let i = end; i > 0; i -= i & -i) sum += this.sums[i]!
    return sum
  }

  private range(start: number, count: number): number {
    const end = start + count
    return end <= this.times.length ? this.prefix(end) - this.prefix(start)
      : this.prefix(this.times.length) - this.prefix(start) + this.prefix(end - this.times.length)
  }

  /** Find the first slot whose inclusive prefix meets a positive target. */
  private find(target: number): number {
    let index = 0
    for (let step = 2 ** Math.floor(Math.log2(this.times.length)); step; step = Math.floor(step / 2)) {
      const next = index + step
      if (next <= this.times.length && this.sums[next]! < target) {
        target -= this.sums[next]!
        index = next
      }
    }
    return index
  }

  private now(): number {
    const value = this.clock()
    if (!Number.isFinite(value)) throw new TypeError("Invalid monotonic clock.")
    this.last = Math.max(this.last, value)
    if (this.count && this.times[this.head]! <= this.last - 60_000) {
      if (this.times[(this.head + this.count - 1) % this.times.length]! <= this.last - 60_000) {
        this.head = (this.head + this.count) % this.times.length
        this.count = 0
        this.total = 0
        return this.last
      }
      let low = 0, high = this.count
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (this.times[(this.head + middle) % this.times.length]! <= this.last - 60_000) low = middle + 1
        else high = middle
      }
      this.total -= this.range(this.head, low)
      this.head = (this.head + low) % this.times.length
      this.count -= low
    }
    return this.last
  }

  probe(tokens = 1): RateLimitCheckResult {
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw new TypeError("Token reservation must be a positive safe integer.")
    const now = this.now()
    const rpm = this.maxRpm !== undefined && this.count >= this.maxRpm
    const tpm = this.maxTpm !== undefined && this.total + tokens > this.maxTpm
    let retry = 1
    if (rpm || tpm) {
      if (this.count) {
        let index = this.head
        if (tpm && tokens <= this.maxTpm!) {
          const required = this.total + tokens - this.maxTpm!
          const before = this.prefix(this.head)
          const tail = this.prefix(this.times.length) - before
          index = required <= tail ? this.find(before + required) : this.find(required - tail)
        }
        retry = Math.max(1, Math.ceil((this.times[index]! + 60_000 - now) / 1000))
      }
      // A request larger than the entire capacity cannot fit after a reset.
      if (tokens > (this.maxTpm ?? Infinity)) retry = 60
    }
    return { allowed: !rpm && !tpm, retryAfterSeconds: rpm || tpm ? retry : undefined,
      currentRpm: this.count, currentTpm: this.total, limitRpm: this.maxRpm, limitTpm: this.maxTpm,
      reason: rpm ? "RPM_EXCEEDED" : tpm ? "TPM_EXCEEDED" : undefined }
  }

  /** Internal commit immediately after all hierarchy probes succeed. */
  consume(tokens: number): void {
    if (!this.times.length) return
    const index = (this.head + this.count) % this.times.length
    this.times[index] = this.last
    const reserved = this.maxTpm === undefined ? 1 : tokens
    const delta = reserved - this.tokens[index]!
    this.tokens[index] = reserved
    for (let i = index + 1; i < this.sums.length; i += i & -i) this.sums[i] = this.sums[i]! + delta
    this.count++
    this.total += reserved
  }

  check(tokens = 1): RateLimitCheckResult {
    const result = this.probe(tokens)
    if (result.allowed) this.consume(tokens)
    return result
  }
}
