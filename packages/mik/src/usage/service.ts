import type { Store } from "../store/database.js"
import type { UsageBucket, UsageEvent, UsagePage, UsageQuery, UsageSummary, UsageTrendPoint } from "../types.js"

export interface UsageServiceDeps {
  store: Store
  appId: string
  enabled: boolean
  onEvent?: (event: UsageEvent) => void
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

  constructor(deps: UsageServiceDeps) {
    this.store = deps.store
    this.appId = deps.appId
    this.enabled = deps.enabled
    this.onEvent = deps.onEvent
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
   */
  record(event: Omit<UsageEvent, "appId"> & { appId?: string }): boolean {
    if (!this.enabled) return false
    const stored: UsageEvent = { ...event, appId: event.appId ?? this.appId }
    if (!this.store.usage.insert(stored)) return false
    this.onEvent?.(stored)
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

  /** Lookup by request id. Ids are global, so there is nothing to scope. */
  get(requestId: string): UsageEvent | null {
    return this.store.usage.get(requestId)
  }

  /** Fold old detail rows into daily rollups and prune, returning rows deleted. */
  rollupAndPrune(now?: number, retentionDays?: number): number {
    return this.store.usage.rollupAndPrune(now ?? Date.now(), retentionDays)
  }

  /** Delete every event and rollup belonging to this app, returning rows deleted. */
  clear(): number {
    return this.store.usage.deleteAll(this.appId)
  }
}
