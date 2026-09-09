import type { Store } from "../store/database.js"
import type { UsageBucket, UsageEvent, UsagePage, UsageQuery, UsageSummary, UsageTrendPoint } from "../types.js"

export interface UsageServiceDeps {
  store: Store
  appId: string
  enabled: boolean
  onEvent?: (event: UsageEvent) => void
  /** Diagnostics sink. A throwing `onEvent` listener is reported here, never rethrown. */
  onWarn?: (message: string, error?: unknown) => void
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

  constructor(deps: UsageServiceDeps) {
    this.store = deps.store
    this.appId = deps.appId
    this.enabled = deps.enabled
    this.onEvent = deps.onEvent
    this.onWarn = deps.onWarn
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
   */
  record(event: Omit<UsageEvent, "appId"> & { appId?: string }): boolean {
    if (!this.enabled) return false
    const stored: UsageEvent = { ...event, appId: event.appId ?? this.appId }
    if (!this.store.usage.insert(stored)) return false
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
