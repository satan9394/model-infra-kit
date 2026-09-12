import type { Store } from "../store/database.js"
import type {
  BudgetConfig,
  UnpricedCoverage,
  UsageBucket,
  UsageEvent,
  UsagePage,
  UsageQuery,
  UsageSummary,
  UsageTrendPoint,
} from "../types.js"
import { redact } from "../util/redact.js"

/** A budget window. Both are **UTC**-aligned, never the host's local midnight. */
export type BudgetWindow = "day" | "month"

/** The config plus the base `ModelInfra.init()` already summed from the store. */
export interface BudgetDeps extends BudgetConfig {
  /**
   * Cost already recorded in the *current* window, in integer micro-USD, summed
   * once at init. Defaults to 0 (also the fallback when that sum failed).
   */
  baseMicros?: number
  /** Clock, injected by tests. Defaults to `Date.now`. */
  now?: () => number
}

/** Round a USD amount to integer micro-USD, the same way the SQL aggregate does. */
export function toMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000)
}

/** The UTC start of the window containing `ts` (day or month boundary). */
export function windowStart(window: BudgetWindow, ts: number): number {
  const at = new Date(ts)
  return window === "month"
    ? Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)
    : Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
}

/**
 * Whether a `budget` config can be honoured at all.
 *
 * A typo (`0`, a negative number, `NaN`, an unsupported `onExceed`) must never
 * be fatal: it makes the feature inactive, nothing else (A4).
 */
export function isUsableBudget(budget: BudgetConfig | undefined): boolean {
  if (!budget || typeof budget.usd !== "number" || !Number.isFinite(budget.usd) || budget.usd <= 0) return false
  if (budget.window !== undefined && budget.window !== "day" && budget.window !== "month") return false
  return budget.onExceed === undefined || budget.onExceed === "warn"
}

/** `1234567` micro-USD → `"1.234567"`, for a message a human reconciles against a bill. */
function formatMicros(micros: number): string {
  return (micros / 1_000_000).toFixed(6)
}

/**
 * Total the cost already recorded for one app inside the window containing
 * `now`, as an integer micro-USD base for the in-memory running total.
 *
 * Called **once** per process, from `init()`: the per-`record()` path must never
 * pay for a table scan. Never throws (rule 6, A4): a failing store degrades the
 * base to 0 and the budget to "count from here".
 */
export function budgetBaseMicros(deps: {
  store: Pick<Store, "usage">
  appId: string
  window: BudgetWindow
  now: number
  onWarn?: (message: string, error?: unknown) => void
}): number {
  try {
    return deps.store.usage.costMicros(deps.appId, windowStart(deps.window, deps.now), deps.now)
  } catch (error) {
    try {
      deps.onWarn?.(
        redact(
          `Could not total the usage already recorded for app "${deps.appId}" this window; the budget starts from 0.`,
        ),
        error,
      )
    } catch {
      // A throwing warn sink is a host concern, never a reason to fail init.
    }
    return 0
  }
}

/** The validated, in-memory form of a `BudgetDeps`. */
interface ActiveBudget {
  window: BudgetWindow
  thresholdMicros: number
  now: () => number
  onWarn: ((message: string, error?: unknown) => void) | undefined
}

export interface UsageServiceDeps {
  store: Store
  appId: string
  enabled: boolean
  onEvent?: (event: UsageEvent) => void
  /** Diagnostics sink. A throwing `onEvent` listener is reported here, never rethrown. */
  onWarn?: (message: string, error?: unknown) => void
  /**
   * Soft, warn-only spend threshold. Absent means off: no query, no warning.
   * `baseMicros` is the window total `init()` already summed from the store.
   */
  budget?: BudgetDeps
}

/**
 * The metering facade a host talks to. It owns no SQL: every read is a
 * pass-through to `store.usage`, scoped to this instance's `appId` unless the
 * caller asks for another one.
 *
 * `record()` is the only mutating path and it is idempotent per `request_id`:
 * a duplicate returns `false` and leaves the stored row untouched, so a
 * retried request can never double-count or rewrite history.
 */
export class UsageService {
  private readonly store: Store
  private readonly appId: string
  private readonly enabled: boolean
  private readonly onEvent: ((event: UsageEvent) => void) | undefined
  private readonly onWarn: ((message: string, error?: unknown) => void) | undefined
  /** `undefined` unless a usable `budget` was configured — the whole feature's switch. */
  private readonly budget: ActiveBudget | undefined
  /** Running window total in integer micro-USD; never a float accumulator (rule 2). */
  private budgetAccumMicros = 0
  /** UTC start of the window the running total belongs to. */
  private budgetWindowKey = 0
  /** `appId|windowStart` pairs already warned about, so each window warns once. */
  private readonly budgetWarned = new Set<string>()

  constructor(deps: UsageServiceDeps) {
    this.store = deps.store
    this.appId = deps.appId
    this.enabled = deps.enabled
    this.onEvent = deps.onEvent
    this.onWarn = deps.onWarn
    this.budget = this.resolveBudget(deps.budget)
  }

  /**
   * Validate the budget once, at construction — which is `init()` — and turn it
   * into the running-total seed. An unusable config is reported once and then
   * ignored entirely (A4): a typo in a threshold must never fail construction
   * or a later call.
   */
  private resolveBudget(config: BudgetDeps | undefined): ActiveBudget | undefined {
    if (!config) return undefined
    if (!isUsableBudget(config)) {
      this.warnOnce(
        `Ignoring the invalid budget configuration for app "${this.appId}": usd must be a positive number and onExceed, if set, must be "warn".`,
      )
      return undefined
    }
    const window = config.window ?? "day"
    const now = config.now ?? Date.now
    this.budgetAccumMicros = config.baseMicros ?? 0
    try {
      this.budgetWindowKey = windowStart(window, now())
    } catch {
      // A broken clock is no reason to drop the budget; the first record resets it.
    }
    return { window, thresholdMicros: toMicroUsd(config.usd), now, onWarn: this.onWarn }
  }

  /**
   * Fold one committed row into the window total and, the **first** time the
   * threshold is crossed in this window, emit the single advisory warning.
   *
   * The whole body is defensive on purpose: a budget is an advisory signal, so
   * a bad config, a broken clock or a throwing warn sink must never change what
   * `record()` returns or whether the caller's request succeeds (A4).
   */
  private noteBudget(event: UsageEvent): void {
    const budget = this.budget
    if (!budget) return
    // The init base only covers this instance's own appId, so another app's row
    // must not be added on top of it.
    if (event.appId !== this.appId) return
    try {
      const key = windowStart(budget.window, budget.now())
      if (key !== this.budgetWindowKey) {
        // Crossed a UTC day/month boundary: the base belonged to the old window.
        this.budgetWindowKey = key
        this.budgetAccumMicros = 0
      }
      this.budgetAccumMicros += toMicroUsd(event.cost.usd)
      if (this.budgetAccumMicros <= budget.thresholdMicros) return
      const seen = `${this.appId}|${key}`
      if (this.budgetWarned.has(seen)) return
      this.budgetWarned.add(seen)
      budget.onWarn?.(
        redact(
          `Usage budget exceeded for app "${this.appId}" (window "${budget.window}", UTC): $${formatMicros(
            this.budgetAccumMicros,
          )} recorded this window against a $${formatMicros(
            budget.thresholdMicros,
          )} threshold. This is a warning only — requests are never blocked, queued or rate limited.`,
        ),
      )
    } catch {
      // Silent by design (A4).
    }
  }

  /** Report a non-fatal diagnostic without letting a throwing sink escape. */
  private warnOnce(message: string): void {
    try {
      this.onWarn?.(redact(message))
    } catch {
      // A host's warn sink is never allowed to break construction or metering.
    }
  }

  /** The app every query defaults to. Additive convenience, not part of the contract. */
  get currentAppId(): string {
    return this.appId
  }

  /** Whether writes are persisted. Additive convenience, not part of the contract. */
  get isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Persist one request. Returns `false` when metering is disabled or the
   * `requestId` already exists (the existing row is kept as-is).
   *
   * On success the stored event — with `appId` filled in — is handed to
   * `onEvent` exactly once, which is what feeds the dashboard SSE stream.
   *
   * A throwing `onEvent` listener is a diagnostic concern, not a metering one:
   * the row is already committed, so the exception is caught and reported to
   * `onWarn` and `record()` still returns `true`. Metering never fails because
   * a subscriber did.
   *
   * A configured `budget` folds the committed row into the window's running
   * total here. That is a pure in-memory addition plus, at most once per window,
   * one `onWarn` call — no SQL, and no effect on the return value (A1/A2).
   */
  record(event: Omit<UsageEvent, "appId"> & { appId?: string }): boolean {
    if (!this.enabled) return false
    const stored: UsageEvent = { ...event, appId: event.appId ?? this.appId }
    if (!this.store.usage.insert(stored)) return false
    this.noteBudget(stored)
    try {
      this.onEvent?.(stored)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.onWarn?.(`Usage event listener failed for request "${stored.requestId}": ${message}`, error)
    }
    return true
  }

  /**
   * Fill in this instance's `appId` unless the caller was explicit about it.
   * Passing `appId: ""` deliberately disables the filter (all apps).
   */
  private scoped(query?: UsageQuery): UsageQuery {
    return { ...query, appId: query?.appId ?? this.appId }
  }

  summary(query?: UsageQuery): UsageSummary {
    return this.store.usage.summary(this.scoped(query))
  }

  /**
   * How much of the range carries no resolved price (EVO-G74), for the
   * `usage summary` to-do block. Display-only: it feeds no cost total and
   * changes no existing figure.
   *
   * Detail rows only — `usage_daily_rollups` has no `pricing_source` — so both
   * sides of its ratios are measured over the rows whose provenance still
   * exists. See `UnpricedCoverage` for the exact accounting.
   */
  unpricedCoverage(query?: UsageQuery): UnpricedCoverage {
    return this.store.usage.unpricedCoverage(this.scoped(query))
  }

  trends(query?: UsageQuery, bucket?: "day" | "hour"): UsageTrendPoint[] {
    return this.store.usage.trends(this.scoped(query), bucket)
  }

  byProvider(query?: UsageQuery): UsageBucket[] {
    return this.store.usage.byProvider(this.scoped(query))
  }

  byModel(query?: UsageQuery): UsageBucket[] {
    return this.store.usage.byModel(this.scoped(query))
  }

  query(filter?: UsageQuery): UsagePage {
    return this.store.usage.query(this.scoped(filter))
  }

  /**
   * Lookup by request id, scoped to this instance's `appId` by default: when
   * several apps share one database, an id belonging to another app reads as
   * `null` rather than leaking that app's detail row.
   *
   * Pass `{ appId: "" }` to disable the filter explicitly (debugging), with the
   * same semantics as `scoped()`.
   */
  get(requestId: string, options?: { appId?: string }): UsageEvent | null {
    const event = this.store.usage.get(requestId)
    if (!event) return null
    const scope = options?.appId ?? this.appId
    if (scope === "") return event
    return event.appId === scope ? event : null
  }

  /**
   * **Global maintenance operation.** Folds the expired detail rows of *every*
   * app into its daily rollups and deletes them, ignoring this instance's
   * `appId`. That is deliberate — retention is a database-wide concern — and it
   * is why this differs from `clear()`, which is app-scoped. Call it from one
   * owner (CLI/dashboard maintenance), not per app instance.
   *
   * Returns the number of detail rows deleted.
   */
  rollupAndPrune(now?: number, retentionDays?: number): number {
    return this.store.usage.rollupAndPrune(now ?? Date.now(), retentionDays)
  }

  /** Delete every event and rollup belonging to this app, returning rows deleted. */
  clear(): number {
    return this.store.usage.deleteAll(this.appId)
  }
}
