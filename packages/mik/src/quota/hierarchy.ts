import { RateLimiter, type TenantQuotaConfig, type RateLimitCheckResult } from "./rate-limiter.js"

interface NodeQuota { config: TenantQuotaConfig; limiter: RateLimiter; apps: string[] }
export interface TenantQuotas {
  organizations?: Omit<TenantQuotaConfig, "appId">[]
  applications: TenantQuotaConfig[]
}

const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)
function validate(config: TenantQuotaConfig): void {
  if (!validId(config.appId) || config.orgId !== undefined && !validId(config.orgId)) throw new TypeError("Invalid quota tenant identity.")
  for (const cap of [config.dailyHardCapMicros, config.monthlyHardCapMicros]) {
    if (cap !== undefined && (typeof cap !== "bigint" || cap < 0n)) throw new TypeError("Quota budgets require nonnegative bigint microdollars.")
  }
}

/** Server-owned identity map. Unknown identities never allocate limiter state. */
export class QuotaHierarchy {
  private readonly apps = new Map<string, NodeQuota>()
  private readonly orgs = new Map<string, NodeQuota>()
  private wall = 0
  constructor(config: TenantQuotas, private readonly spend: (app: string, from: number, to: number) => bigint,
    clock = () => performance.now(), private readonly wallClock = () => Date.now()) {
    if (!Array.isArray(config.applications) || config.applications.length + (config.organizations?.length ?? 0) > 4096) throw new TypeError("Too many quota tenants.")
    let slots = 0
    for (const entry of [...config.applications, ...config.organizations ?? []]) {
      const capacity = Math.min(entry.maxRpm ?? Infinity, entry.maxTpm ?? Infinity)
      slots += Number.isFinite(capacity) ? capacity : 0
    }
    if (slots > 1_000_000) throw new TypeError("Quota rate state exceeds memory budget.")
    const node = (value: TenantQuotaConfig): NodeQuota => {
      validate(value)
      return { config: { ...value }, limiter: new RateLimiter(value, clock), apps: [] }
    }
    for (const org of config.organizations ?? []) {
      if (!org.orgId || this.orgs.has(org.orgId)) throw new TypeError("Invalid or duplicate quota organization.")
      this.orgs.set(org.orgId, node({ ...org, appId: org.orgId }))
    }
    for (const app of config.applications) {
      if (this.apps.has(app.appId)) throw new TypeError("Duplicate quota application.")
      const entry = node(app)
      entry.apps.push(app.appId)
      this.apps.set(app.appId, entry)
      if (app.orgId) {
        const parent = this.orgs.get(app.orgId)
        if (!parent) throw new TypeError("Unknown quota organization.")
        parent.apps.push(app.appId)
      }
    }
  }

  private periods() {
    const value = this.wallClock()
    if (!Number.isFinite(value)) throw new TypeError("Invalid quota wall clock.")
    this.wall = Math.max(this.wall, value)
    const date = new Date(this.wall)
    return { day: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      nextDay: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
      nextMonth: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) }
  }

  private total(node: NodeQuota, from: number, to: number): bigint {
    let total = 0n
    for (const app of node.apps) {
      const value = this.spend(app, from, to)
      if (typeof value !== "bigint" || value < 0n) throw new TypeError("Invalid quota ledger total.")
      total += value
    }
    return total
  }

  check(appId: string, tokens = 1): RateLimitCheckResult {
    if (!validId(appId)) throw new TypeError("Invalid quota tenant identity.")
    const app = this.apps.get(appId)
    if (!app) throw new TypeError("Application has no configured quota.")
    const parent = app.config.orgId ? this.orgs.get(app.config.orgId) : undefined
    const periods = this.periods()
    for (const entry of [parent, app]) {
      if (!entry) continue
      let retry = 0
      for (const [cap, from, to] of [[entry.config.dailyHardCapMicros, periods.day, periods.nextDay],
        [entry.config.monthlyHardCapMicros, periods.month, periods.nextMonth]] as const) {
        if (cap !== undefined && this.total(entry, from, to) >= cap) retry = Math.max(retry, Math.ceil((to - this.wall) / 1000))
      }
      if (retry) return { ...entry.limiter.probe(tokens), allowed: false, retryAfterSeconds: Math.max(1, retry),
        reason: entry === parent ? "ORG_BUDGET_EXCEEDED" : "APP_BUDGET_EXCEEDED" }
    }
    const childResult = app.limiter.probe(tokens)
    const parentResult = parent?.limiter.probe(tokens)
    if (parentResult && !parentResult.allowed) return parentResult
    if (!childResult.allowed) return childResult
    // No asynchronous boundary between either probe and either commit.
    app.limiter.consume(tokens)
    parent?.limiter.consume(tokens)
    return childResult
  }

  hasTokenLimit(appId: string): boolean {
    const app = this.apps.get(appId)
    return app?.config.maxTpm !== undefined || !!(app?.config.orgId && this.orgs.get(app.config.orgId)?.config.maxTpm !== undefined)
  }

  hasApp(appId: string): boolean { return this.apps.has(appId) }

  snapshot(appId: string) {
    const app = this.apps.get(appId)
    if (!app) return []
    const periods = this.periods()
    const view = (entry: NodeQuota) => ({ ...entry.limiter.probe(),
      dailySpentMicros: this.total(entry, periods.day, periods.nextDay).toString(),
      monthlySpentMicros: this.total(entry, periods.month, periods.nextMonth).toString(),
      dailyHardCapMicros: entry.config.dailyHardCapMicros?.toString(), monthlyHardCapMicros: entry.config.monthlyHardCapMicros?.toString() })
    return [{ appId, orgId: app.config.orgId, ...view(app), org: app.config.orgId ? view(this.orgs.get(app.config.orgId)!) : undefined }]
  }
}
