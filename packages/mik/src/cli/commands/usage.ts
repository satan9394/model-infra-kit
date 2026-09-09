import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { UsageEvent, UsageQuery } from "../../types.js"
import type { UsageService } from "../../usage/service.js"
import { flagNumber, flagString, type ParsedCli } from "../args.js"
import { resolveCwd, withContext, type RunOptions } from "../context.js"
import { usageCsv } from "../csv.js"
import { CliUsageError } from "../errors.js"
import {
  formatDate,
  formatDuration,
  formatKeyValues,
  formatMoney,
  formatPercent,
  formatTable,
  formatTimestamp,
  formatTokens,
} from "../format.js"

const MAX_EXPORT_ROWS = 200_000
const PAGE_SIZE = 1000

/**
 * Accept a plain date, an ISO timestamp or epoch milliseconds.
 *
 * A plain `--to` date means "the whole of that day", so it is advanced to the
 * start of the next day, which pairs with the repository's `ts < to` filter.
 */
export function parseTime(input: string, end: boolean, flag: string): number {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    if (Number.isNaN(date.getTime())) throw new CliUsageError(`${flag} is not a valid date: "${input}".`)
    if (end) date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    throw new CliUsageError(`${flag} expects YYYY-MM-DD, an ISO timestamp or epoch ms, got "${input}".`)
  }
  return parsed
}

export function buildUsageQuery(parsed: ParsedCli): UsageQuery {
  const query: UsageQuery = {}
  const from = flagString(parsed.values, "from")
  if (from) query.from = parseTime(from, false, "--from")
  const to = flagString(parsed.values, "to")
  if (to) query.to = parseTime(to, true, "--to")
  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
    throw new CliUsageError("--from must be earlier than --to.")
  }
  const app = flagString(parsed.values, "app")
  if (app) query.appId = app
  const provider = flagString(parsed.values, "provider")
  if (provider) query.providerId = provider
  const model = flagString(parsed.values, "model")
  if (model) query.model = model
  const status = flagString(parsed.values, "status")
  if (status) {
    if (status !== "ok" && status !== "error") {
      throw new CliUsageError(`--status must be "ok" or "error", got "${status}".`)
    }
    query.status = status
  }
  return query
}

function startOfTomorrow(): number {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now.getTime() + 86_400_000
}

/** `--days` only fills a missing bound; explicit `--from`/`--to` always win. */
function applyDays(query: UsageQuery, parsed: ParsedCli): UsageQuery {
  const days = flagNumber(parsed.values, "days", parsed.action?.usage) ?? 30
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new CliUsageError(`--days must be an integer between 1 and 3650, got ${days}.`)
  }
  const result: UsageQuery = { ...query }
  if (result.to === undefined) result.to = startOfTomorrow()
  if (result.from === undefined) result.from = result.to - days * 86_400_000
  return result
}

function rangeLabel(query: UsageQuery, appId: string): string {
  const from = query.from === undefined ? "-" : formatDate(query.from)
  const to = query.to === undefined ? "-" : formatDate(query.to - 1)
  const scope = query.appId ?? appId
  const filters = [
    query.providerId ? `provider=${query.providerId}` : null,
    query.model ? `model=${query.model}` : null,
    query.status ? `status=${query.status}` : null,
  ].filter((item): item is string => item !== null)
  return `Range ${from} → ${to} · app=${scope}${filters.length > 0 ? ` · ${filters.join(" ")}` : ""}`
}

async function runSummary(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const query = buildUsageQuery(parsed)
  return withContext(parsed, options, async (context) => {
    const summary = context.hub.usage.summary(query)
    context.io.out(rangeLabel(query, context.appId))
    context.io.out("")
    context.io.out(
      formatKeyValues([
        ["Requests", formatTokens(summary.requests)],
        ["Successes", formatTokens(summary.successes)],
        ["Failures", formatTokens(summary.failures)],
        ["Success rate", formatPercent(summary.successRate)],
        ["Cost (USD)", formatMoney(summary.costUsd)],
        ["Cost range", `${formatMoney(summary.costLowUsd)} – ${formatMoney(summary.costHighUsd)}`],
        ["Input tokens", formatTokens(summary.tokens.input)],
        ["Output tokens", formatTokens(summary.tokens.output)],
        ["Cache read", formatTokens(summary.tokens.cacheRead)],
        ["Cache write", formatTokens(summary.tokens.cacheWrite)],
        ["Reasoning", formatTokens(summary.tokens.reasoning)],
        ["Cache hit rate", formatPercent(summary.cacheHitRate)],
        ["Avg latency", formatDuration(summary.avgLatencyMs)],
        ["First token", formatDuration(summary.firstTokenMs)],
      ]),
    )
    return 0
  })
}

async function runTrends(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const query = applyDays(buildUsageQuery(parsed), parsed)
  return withContext(parsed, options, async (context) => {
    const points = context.hub.usage.trends(query)
    context.io.out(rangeLabel(query, context.appId))
    context.io.out("")
    if (points.length === 0) {
      context.io.out("No usage recorded in this range.")
      return 0
    }
    const rows = points.map((point) => [
      point.date,
      formatTokens(point.requests),
      formatTokens(point.tokens.input),
      formatTokens(point.tokens.output),
      formatTokens(point.tokens.cacheRead),
      formatMoney(point.costUsd),
    ])
    const totals = points.reduce(
      (accumulator, point) => ({
        requests: accumulator.requests + point.requests,
        input: accumulator.input + point.tokens.input,
        output: accumulator.output + point.tokens.output,
        cacheRead: accumulator.cacheRead + point.tokens.cacheRead,
        cost: accumulator.cost + point.costUsd,
      }),
      { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 },
    )
    rows.push([
      "TOTAL",
      formatTokens(totals.requests),
      formatTokens(totals.input),
      formatTokens(totals.output),
      formatTokens(totals.cacheRead),
      formatMoney(totals.cost),
    ])
    context.io.out(
      formatTable(["DATE", "REQUESTS", "INPUT", "OUTPUT", "CACHE READ", "COST USD"], rows, [
        "left",
        "right",
        "right",
        "right",
        "right",
        "right",
      ]),
    )
    return 0
  })
}

function logRows(events: readonly UsageEvent[]): string[][] {
  return events.map((event) => [
    formatTimestamp(event.ts),
    event.appId,
    event.providerId,
    event.modelActual,
    event.status,
    formatTokens(event.usage.input),
    formatTokens(event.usage.output),
    formatMoney(event.cost.usd),
    formatDuration(event.latencyMs),
  ])
}

async function runLogs(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const query = buildUsageQuery(parsed)
  const limit = flagNumber(parsed.values, "limit", parsed.action?.usage) ?? 20
  const offset = flagNumber(parsed.values, "offset", parsed.action?.usage) ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new CliUsageError(`--limit must be an integer between 1 and 1000, got ${limit}.`)
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CliUsageError(`--offset must be zero or greater, got ${offset}.`)
  }

  return withContext(parsed, options, async (context) => {
    const page = context.hub.usage.query({ ...query, limit, offset })
    context.io.out(rangeLabel(query, context.appId))
    context.io.out("")
    if (page.events.length === 0) {
      context.io.out("No usage recorded in this range.")
      return 0
    }
    context.io.out(
      formatTable(
        ["TS", "APP", "PROVIDER", "MODEL", "STATUS", "INPUT", "OUTPUT", "COST USD", "LATENCY"],
        logRows(page.events),
        ["left", "left", "left", "left", "left", "right", "right", "right", "right"],
      ),
    )
    context.io.out("")
    context.io.out(`Showing ${formatTokens(page.events.length)} of ${formatTokens(page.total)} event(s) (offset ${offset}).`)
    return 0
  })
}

function collectAll(query: UsageQuery, usage: UsageService): UsageEvent[] {
  const events: UsageEvent[] = []
  let offset = 0
  for (;;) {
    const page = usage.query({ ...query, limit: PAGE_SIZE, offset })
    events.push(...page.events)
    offset += page.events.length
    if (page.events.length === 0 || events.length >= page.total || events.length >= MAX_EXPORT_ROWS) break
  }
  return events
}

async function runExport(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const format = (flagString(parsed.values, "format") ?? "csv").toLowerCase()
  if (format !== "csv") {
    throw new CliUsageError(`--format "${format}" is not supported yet; only csv is available.`, parsed.action?.usage)
  }
  const query = buildUsageQuery(parsed)
  const out = flagString(parsed.values, "out")
  const cwd = resolveCwd(options)

  return withContext(parsed, options, async (context) => {
    const events = collectAll(query, context.hub.usage)
    const csv = usageCsv(events)
    if (out) {
      const target = resolve(cwd, out)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, csv, "utf8")
      context.io.out(`Wrote ${formatTokens(events.length)} row(s) to ${target}`)
    } else {
      context.io.out(csv.replace(/\n$/, ""))
    }
    if (events.length >= MAX_EXPORT_ROWS) {
      context.io.err(`warning: export stopped at ${formatTokens(MAX_EXPORT_ROWS)} rows; narrow the range with --from/--to.`)
    }
    return 0
  })
}

export async function runUsage(parsed: ParsedCli, options: RunOptions): Promise<number> {
  switch (parsed.action?.name) {
    case "summary":
      return runSummary(parsed, options)
    case "trends":
      return runTrends(parsed, options)
    case "logs":
      return runLogs(parsed, options)
    case "export":
      return runExport(parsed, options)
    default:
      throw new CliUsageError(`Unknown usage action "${parsed.action?.name ?? ""}".`, parsed.command?.usage)
  }
}
