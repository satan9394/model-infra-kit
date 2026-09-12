import type { CostInfo, TokenUsage, UnpricedCoverage, UsageEvent, UsageQuery, UsageSummary, UsageTrendPoint, UsageBucket } from "../types.js"
import { asNumber, asString, toSqlValue, type SqlDriver, type SqlValue } from "./driver.js"
import { fromMicroUsd, localDateKey, localHourKey, startOfLocalDay, toMicroUsd } from "./money.js"

const EMPTY_TOKENS = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

interface Where {
  clause: string
  params: SqlValue[]
}

function buildWhere(query: UsageQuery, column: "ts" | "date"): Where {
  const parts: string[] = []
  const params: SqlValue[] = []

  if (query.from !== undefined) {
    if (column === "ts") {
      parts.push("ts >= ?")
      params.push(query.from)
    } else {
      parts.push("date >= ?")
      params.push(localDateKey(query.from))
    }
  }
  if (query.to !== undefined) {
    if (column === "ts") {
      parts.push("ts < ?")
      params.push(query.to)
    } else {
      parts.push("date <= ?")
      params.push(localDateKey(query.to - 1))
    }
  }
  if (query.appId) {
    parts.push("app_id = ?")
    params.push(query.appId)
  }
  if (query.providerId) {
    parts.push("provider_id = ?")
    params.push(query.providerId)
  }
  if (query.model) {
    parts.push(column === "ts" ? "model_actual = ?" : "model = ?")
    params.push(query.model)
  }
  if (query.status && column === "ts") {
    parts.push("status = ?")
    params.push(query.status)
  }
  if (query.sessionId && column === "ts") {
    parts.push("session_id = ?")
    params.push(query.sessionId)
  }
  return { clause: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", params }
}

function rowToEvent(row: Record<string, unknown>): UsageEvent {
  const cost: CostInfo = {
    usd: asNumber(row.cost_usd),
    low: asNumber(row.cost_low_usd),
    high: asNumber(row.cost_high_usd),
    basis: (asString(row.pricing_basis) || "flat") as CostInfo["basis"],
    source: (asString(row.pricing_source) || "missing") as CostInfo["source"],
    pricingModel: row.pricing_model ? asString(row.pricing_model) : undefined,
  }
  return {
    requestId: asString(row.request_id),
    appId: asString(row.app_id),
    ts: asNumber(row.ts),
    source: asString(row.source),
    providerId: asString(row.provider_id),
    modelRequested: asString(row.model_requested),
    modelActual: asString(row.model_actual),
    pricingModel: row.pricing_model ? asString(row.pricing_model) : undefined,
    usage: {
      input: asNumber(row.input_tokens),
      output: asNumber(row.output_tokens),
      cacheRead: asNumber(row.cache_read_tokens),
      cacheWrite: asNumber(row.cache_write_tokens),
      reasoning: asNumber(row.reasoning_tokens),
    },
    cost,
    latencyMs: row.latency_ms === null ? undefined : asNumber(row.latency_ms),
    firstTokenMs: row.first_token_ms === null ? undefined : asNumber(row.first_token_ms),
    status: asString(row.status, "ok") as UsageEvent["status"],
    errorCode: row.error_code ? asString(row.error_code) : undefined,
    isStreaming: asNumber(row.is_streaming) === 1,
    sessionId: row.session_id ? asString(row.session_id) : undefined,
    tags: typeof row.tags_json === "string" && row.tags_json ? (JSON.parse(row.tags_json) as Record<string, string>) : {},
  }
}

interface AggregateRow {
  requests: number
  successes: number
  tokens: TokenUsage
  costMicro: number
  lowMicro: number
  highMicro: number
  latencySum: number
  latencyCount: number
  firstTokenSum: number
  firstTokenCount: number
}

function emptyAggregate(): AggregateRow {
  return {
    requests: 0,
    successes: 0,
    tokens: EMPTY_TOKENS(),
    costMicro: 0,
    lowMicro: 0,
    highMicro: 0,
    latencySum: 0,
    latencyCount: 0,
    firstTokenSum: 0,
    firstTokenCount: 0,
  }
}

function addAggregate(target: AggregateRow, source: AggregateRow): AggregateRow {
  target.requests += source.requests
  target.successes += source.successes
  target.tokens.input += source.tokens.input
  target.tokens.output += source.tokens.output
  target.tokens.cacheRead += source.tokens.cacheRead
  target.tokens.cacheWrite += source.tokens.cacheWrite
  target.tokens.reasoning += source.tokens.reasoning
  target.costMicro += source.costMicro
  target.lowMicro += source.lowMicro
  target.highMicro += source.highMicro
  target.latencySum += source.latencySum
  target.latencyCount += source.latencyCount
  target.firstTokenSum += source.firstTokenSum
  target.firstTokenCount += source.firstTokenCount
  return target
}

/**
 * Usage history. Detail rows live in `usage_events`; days older than the
 * rollup cutoff are folded into `usage_daily_rollups` and deleted, so a query
 * sums the two without double counting.
 *
 * Money is accumulated as integer micro-USD in SQL — never as summed floats.
 */
export class UsageRepository {
  constructor(private readonly driver: SqlDriver) {}

  insert(event: UsageEvent & { pricingBasis?: string; pricingSource?: string }): boolean {
    const result = this.driver
      .prepare(
        `INSERT OR IGNORE INTO usage_events (
          request_id, app_id, ts, source, provider_id, model_requested, model_actual, pricing_model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
          cost_usd, cost_low_usd, cost_high_usd, pricing_source, pricing_basis,
          latency_ms, first_token_ms, status, error_code, is_streaming, session_id, tags_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.requestId,
        event.appId,
        event.ts,
        event.source,
        event.providerId,
        event.modelRequested,
        event.modelActual,
        toSqlValue(event.pricingModel ?? event.modelActual),
        event.usage.input,
        event.usage.output,
        event.usage.cacheRead,
        event.usage.cacheWrite,
        event.usage.reasoning,
        event.cost.usd,
        event.cost.low,
        event.cost.high,
        event.cost.source,
        event.cost.basis,
        toSqlValue(event.latencyMs),
        toSqlValue(event.firstTokenMs),
        event.status,
        toSqlValue(event.errorCode),
        event.isStreaming ? 1 : 0,
        toSqlValue(event.sessionId),
        JSON.stringify(event.tags ?? {}),
      )
    return Number(result.changes) > 0
  }

  private aggregateEvents(query: UsageQuery): AggregateRow {
    const where = buildWhere(query, "ts")
    const row = this.driver
      .prepare(
        `SELECT
          COUNT(*) AS requests,
          SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS successes,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens,
          SUM(CAST(ROUND(cost_usd * 1000000) AS INTEGER)) AS cost_micro,
          SUM(CAST(ROUND(cost_low_usd * 1000000) AS INTEGER)) AS low_micro,
          SUM(CAST(ROUND(cost_high_usd * 1000000) AS INTEGER)) AS high_micro,
          SUM(COALESCE(latency_ms, 0)) AS latency_sum,
          SUM(CASE WHEN latency_ms IS NULL THEN 0 ELSE 1 END) AS latency_count,
          SUM(COALESCE(first_token_ms, 0)) AS first_sum,
          SUM(CASE WHEN first_token_ms IS NULL THEN 0 ELSE 1 END) AS first_count
        FROM usage_events${where.clause}`,
      )
      .get(...where.params)
    if (!row) return emptyAggregate()
    return {
      requests: asNumber(row.requests),
      successes: asNumber(row.successes),
      tokens: {
        input: asNumber(row.input_tokens),
        output: asNumber(row.output_tokens),
        cacheRead: asNumber(row.cache_read_tokens),
        cacheWrite: asNumber(row.cache_write_tokens),
        reasoning: asNumber(row.reasoning_tokens),
      },
      costMicro: asNumber(row.cost_micro),
      lowMicro: asNumber(row.low_micro),
      highMicro: asNumber(row.high_micro),
      latencySum: asNumber(row.latency_sum),
      latencyCount: asNumber(row.latency_count),
      firstTokenSum: asNumber(row.first_sum),
      firstTokenCount: asNumber(row.first_count),
    }
  }

  private aggregateRollups(query: UsageQuery): AggregateRow {
    const where = buildWhere(query, "date")
    const row = this.driver
      .prepare(
        `SELECT
          SUM(request_count) AS requests,
          SUM(success_count) AS successes,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens,
          SUM(cost_microusd) AS cost_micro,
          SUM(cost_low_microusd) AS low_micro,
          SUM(cost_high_microusd) AS high_micro,
          SUM(latency_sum_ms) AS latency_sum,
          SUM(latency_count) AS latency_count,
          SUM(first_token_sum_ms) AS first_sum,
          SUM(first_token_count) AS first_count
        FROM usage_daily_rollups${where.clause}`,
      )
      .get(...where.params)
    if (!row) return emptyAggregate()
    return {
      requests: asNumber(row.requests),
      successes: asNumber(row.successes),
      tokens: {
        input: asNumber(row.input_tokens),
        output: asNumber(row.output_tokens),
        cacheRead: asNumber(row.cache_read_tokens),
        cacheWrite: asNumber(row.cache_write_tokens),
        reasoning: asNumber(row.reasoning_tokens),
      },
      costMicro: asNumber(row.cost_micro),
      lowMicro: asNumber(row.low_micro),
      highMicro: asNumber(row.high_micro),
      latencySum: asNumber(row.latency_sum),
      latencyCount: asNumber(row.latency_count),
      firstTokenSum: asNumber(row.first_sum),
      firstTokenCount: asNumber(row.first_count),
    }
  }

  /**
   * Cost already recorded for one app in `[from, to)`, as **integer micro-USD**.
   *
   * This is the soft budget's init-time base (EVO-G07): it is summed once per
   * process and never on the `record()` path. Money is aggregated in SQL as
   * integer micro-USD, exactly like every other total here (rule 2).
   *
   * Detail rows only. `usage_daily_rollups` holds days already older than the
   * retention cutoff, which no budget window (at most one month of the current
   * period) can reach through the normal maintenance path; a host that prunes
   * aggressively will simply see the base start lower, which only ever delays a
   * warning.
   */
  costMicros(appId: string, from: number, to: number): number {
    const row = this.driver
      .prepare(
        `SELECT COALESCE(SUM(CAST(ROUND(cost_usd * 1000000) AS INTEGER)), 0) AS cost_micro
         FROM usage_events WHERE app_id = ? AND ts >= ? AND ts < ?`,
      )
      .get(appId, from, to)
    return asNumber(row?.cost_micro)
  }

  summary(query: UsageQuery = {}): UsageSummary {
    const total = addAggregate(this.aggregateEvents(query), this.aggregateRollups(query))
    const billableInput = total.tokens.input + total.tokens.cacheWrite
    return {
      requests: total.requests,
      successes: total.successes,
      failures: total.requests - total.successes,
      successRate: total.requests === 0 ? 0 : total.successes / total.requests,
      costUsd: fromMicroUsd(total.costMicro),
      costLowUsd: fromMicroUsd(total.lowMicro),
      costHighUsd: fromMicroUsd(total.highMicro),
      tokens: total.tokens,
      cacheHitRate: billableInput === 0 ? 0 : total.tokens.cacheRead / billableInput,
      avgLatencyMs: total.latencyCount === 0 ? 0 : total.latencySum / total.latencyCount,
      firstTokenMs: total.firstTokenCount === 0 ? 0 : total.firstTokenSum / total.firstTokenCount,
    }
  }

  /**
   * Unpriced coverage for a range (EVO-G74): how many requests and tokens carry
   * **no resolved price** (`pricing_source` NULL or `missing`), against the same
   * totals over the same rows, plus a per-model breakdown of the unpriced ones.
   *
   * Detail rows only. `usage_daily_rollups` stores no `pricing_source`, so a
   * rolled-up day is *unmeasurable*: it is left out of both the numerator and
   * the denominator rather than inflating the denominator with rows whose price
   * provenance is gone. `summary()` is untouched by this and still counts them.
   *
   * `NULL` counts as unpriced because the read-back path maps a missing source
   * to `"missing"` (`rowToEvent`); the two must never disagree.
   *
   * Display-only. No money is aggregated here at all, so there is no float sum
   * to avoid (rule 2) — and none of the cost totals change.
   */
  unpricedCoverage(query: UsageQuery = {}): UnpricedCoverage {
    const where = buildWhere(query, "ts")
    const unpriced = "COALESCE(pricing_source, 'missing') = 'missing'"
    const tokens = "input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens"
    const totals = this.driver
      .prepare(
        `SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(${tokens}), 0) AS tokens,
          COALESCE(SUM(CASE WHEN ${unpriced} THEN 1 ELSE 0 END), 0) AS unpriced_requests,
          COALESCE(SUM(CASE WHEN ${unpriced} THEN ${tokens} ELSE 0 END), 0) AS unpriced_tokens
        FROM usage_events${where.clause}`,
      )
      .get(...where.params)
    const models = this.driver
      .prepare(
        `SELECT model_actual AS model, COUNT(*) AS requests, COALESCE(SUM(${tokens}), 0) AS tokens
        FROM usage_events${where.clause === "" ? " WHERE" : `${where.clause} AND`} ${unpriced}
        GROUP BY model_actual`,
      )
      .all(...where.params)
    return {
      requests: asNumber(totals?.unpriced_requests),
      totalRequests: asNumber(totals?.requests),
      tokens: asNumber(totals?.unpriced_tokens),
      totalTokens: asNumber(totals?.tokens),
      models: models
        .map((row) => ({
          model: asString(row.model),
          requests: asNumber(row.requests),
          tokens: asNumber(row.tokens),
        }))
        .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.model.localeCompare(b.model)),
    }
  }

  private groupBy(query: UsageQuery, key: { events: string; rollups: string }): UsageBucket[] {
    const buckets = new Map<string, UsageBucket>()
    const keyAlias = "bucket_key"
    const merge = (key: string, requests: number, costMicro: number, tokens: TokenUsage) => {
      const existing = buckets.get(key) ?? { key, requests: 0, costUsd: 0, tokens: EMPTY_TOKENS() }
      existing.requests += requests
      existing.costUsd = fromMicroUsd(toMicroUsd(existing.costUsd) + costMicro)
      existing.tokens.input += tokens.input
      existing.tokens.output += tokens.output
      existing.tokens.cacheRead += tokens.cacheRead
      existing.tokens.cacheWrite += tokens.cacheWrite
      existing.tokens.reasoning += tokens.reasoning
      buckets.set(key, existing)
    }

    const eventWhere = buildWhere(query, "ts")
    for (const row of this.driver
      .prepare(
        `SELECT ${key.events} AS ${keyAlias}, COUNT(*) AS requests,
          SUM(CAST(ROUND(cost_usd * 1000000) AS INTEGER)) AS cost_micro,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens
        FROM usage_events${eventWhere.clause} GROUP BY ${keyAlias}`,
      )
      .all(...eventWhere.params)) {
      merge(asString(row[keyAlias]), asNumber(row.requests), asNumber(row.cost_micro), {
        input: asNumber(row.input_tokens),
        output: asNumber(row.output_tokens),
        cacheRead: asNumber(row.cache_read_tokens),
        cacheWrite: asNumber(row.cache_write_tokens),
        reasoning: asNumber(row.reasoning_tokens),
      })
    }

    const rollupWhere = buildWhere(query, "date")
    for (const row of this.driver
      .prepare(
        `SELECT ${key.rollups} AS ${keyAlias}, SUM(request_count) AS requests,
          SUM(cost_microusd) AS cost_micro,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens
        FROM usage_daily_rollups${rollupWhere.clause} GROUP BY ${keyAlias}`,
      )
      .all(...rollupWhere.params)) {
      merge(asString(row[keyAlias]), asNumber(row.requests), asNumber(row.cost_micro), {
        input: asNumber(row.input_tokens),
        output: asNumber(row.output_tokens),
        cacheRead: asNumber(row.cache_read_tokens),
        cacheWrite: asNumber(row.cache_write_tokens),
        reasoning: asNumber(row.reasoning_tokens),
      })
    }

    return [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd)
  }

  byProvider(query: UsageQuery = {}): UsageBucket[] {
    return this.groupBy(query, { events: "provider_id", rollups: "provider_id" })
  }

  byModel(query: UsageQuery = {}): UsageBucket[] {
    return this.groupBy(query, { events: "model_actual", rollups: "model" })
  }

  trends(query: UsageQuery = {}, bucket: "day" | "hour" = "day"): UsageTrendPoint[] {
    const points = new Map<string, UsageTrendPoint>()
    const merge = (key: string, requests: number, costMicro: number, tokens: TokenUsage) => {
      const existing = points.get(key) ?? { date: key, requests: 0, costUsd: 0, tokens: EMPTY_TOKENS() }
      existing.requests += requests
      existing.costUsd = fromMicroUsd(toMicroUsd(existing.costUsd) + costMicro)
      existing.tokens.input += tokens.input
      existing.tokens.output += tokens.output
      existing.tokens.cacheRead += tokens.cacheRead
      existing.tokens.cacheWrite += tokens.cacheWrite
      existing.tokens.reasoning += tokens.reasoning
      points.set(key, existing)
    }

    const eventWhere = buildWhere(query, "ts")
    for (const row of this.driver
      .prepare(
        `SELECT ts, COUNT(*) AS requests,
          SUM(CAST(ROUND(cost_usd * 1000000) AS INTEGER)) AS cost_micro,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens
        FROM usage_events${eventWhere.clause} GROUP BY ts`,
      )
      .all(...eventWhere.params)) {
      const ts = asNumber(row.ts)
      merge(bucket === "day" ? localDateKey(ts) : localHourKey(ts), asNumber(row.requests), asNumber(row.cost_micro), {
        input: asNumber(row.input_tokens),
        output: asNumber(row.output_tokens),
        cacheRead: asNumber(row.cache_read_tokens),
        cacheWrite: asNumber(row.cache_write_tokens),
        reasoning: asNumber(row.reasoning_tokens),
      })
    }

    const rollupWhere = buildWhere(query, "date")
    for (const row of this.driver
      .prepare(
        `SELECT date, SUM(request_count) AS requests, SUM(cost_microusd) AS cost_micro,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens
        FROM usage_daily_rollups${rollupWhere.clause} GROUP BY date`,
      )
      .all(...rollupWhere.params)) {
      merge(asString(row.date), asNumber(row.requests), asNumber(row.cost_micro), {
        input: asNumber(row.input_tokens),
        output: asNumber(row.output_tokens),
        cacheRead: asNumber(row.cache_read_tokens),
        cacheWrite: asNumber(row.cache_write_tokens),
        reasoning: asNumber(row.reasoning_tokens),
      })
    }

    return [...points.values()].sort((a, b) => a.date.localeCompare(b.date))
  }

  query(filter: UsageQuery = {}): { total: number; events: UsageEvent[] } {
    const where = buildWhere(filter, "ts")
    const total = asNumber(this.driver.prepare(`SELECT COUNT(*) AS n FROM usage_events${where.clause}`).get(...where.params)?.n)
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000)
    const offset = Math.max(filter.offset ?? 0, 0)
    const rows = this.driver
      .prepare(`SELECT * FROM usage_events${where.clause} ORDER BY ts DESC LIMIT ? OFFSET ?`)
      .all(...where.params, limit, offset)
    return { total, events: rows.map(rowToEvent) }
  }

  get(requestId: string): UsageEvent | null {
    const row = this.driver.prepare("SELECT * FROM usage_events WHERE request_id = ?").get(requestId)
    return row ? rowToEvent(row) : null
  }

  /** Fold events older than `cutoff` into daily rollups, then delete them. */
  rollup(cutoff: number): number {
    this.driver.exec("BEGIN")
    try {
      this.driver
        .prepare(
          `INSERT INTO usage_daily_rollups (
            date, app_id, source, provider_id, model,
            request_count, success_count,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
            cost_microusd, cost_low_microusd, cost_high_microusd,
            latency_sum_ms, latency_count, first_token_sum_ms, first_token_count
          )
          SELECT
            strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS d,
            app_id, source, provider_id, model_actual,
            COUNT(*),
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END),
            SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens),
            SUM(CAST(ROUND(cost_usd * 1000000) AS INTEGER)),
            SUM(CAST(ROUND(cost_low_usd * 1000000) AS INTEGER)),
            SUM(CAST(ROUND(cost_high_usd * 1000000) AS INTEGER)),
            SUM(COALESCE(latency_ms, 0)),
            SUM(CASE WHEN latency_ms IS NULL THEN 0 ELSE 1 END),
            SUM(COALESCE(first_token_ms, 0)),
            SUM(CASE WHEN first_token_ms IS NULL THEN 0 ELSE 1 END)
          FROM usage_events
          WHERE ts < ?
          GROUP BY d, app_id, source, provider_id, model_actual
          ON CONFLICT(date, app_id, source, provider_id, model) DO UPDATE SET
            request_count = request_count + excluded.request_count,
            success_count = success_count + excluded.success_count,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens,
            cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
            cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
            reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
            cost_microusd = cost_microusd + excluded.cost_microusd,
            cost_low_microusd = cost_low_microusd + excluded.cost_low_microusd,
            cost_high_microusd = cost_high_microusd + excluded.cost_high_microusd,
            latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
            latency_count = latency_count + excluded.latency_count,
            first_token_sum_ms = first_token_sum_ms + excluded.first_token_sum_ms,
            first_token_count = first_token_count + excluded.first_token_count`,
        )
        .run(cutoff)
      const deleted = Number(this.driver.prepare("DELETE FROM usage_events WHERE ts < ?").run(cutoff).changes)
      this.driver.exec("COMMIT")
      return deleted
    } catch (error) {
      this.driver.exec("ROLLBACK")
      throw error
    }
  }

  /** Roll up and prune everything older than `retentionDays`. */
  rollupAndPrune(now: number, retentionDays = 30): number {
    const cutoff = startOfLocalDay(now)
    const deleted = this.rollup(cutoff)
    if (retentionDays > 0) {
      const pruneBefore = startOfLocalDay(now - retentionDays * 86_400_000)
      this.driver
        .prepare("DELETE FROM usage_daily_rollups WHERE date < ?")
        .run(localDateKey(pruneBefore))
    }
    return deleted
  }

  deleteAll(appId?: string): number {
    const result = appId
      ? this.driver.prepare("DELETE FROM usage_events WHERE app_id = ?").run(appId)
      : this.driver.prepare("DELETE FROM usage_events").run()
    if (appId) this.driver.prepare("DELETE FROM usage_daily_rollups WHERE app_id = ?").run(appId)
    else this.driver.prepare("DELETE FROM usage_daily_rollups").run()
    return Number(result.changes)
  }
}
