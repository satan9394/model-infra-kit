import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { UnpricedCoverage, UsageBucket, UsageEvent, UsageQuery } from "../../types.js"
import type { UsageService } from "../../usage/service.js"
import { RESERVED_TAG_KEYS, tagLabelForDisplay } from "../../usage/tags.js"
import { flagBool, flagNumber, flagString, type ParsedCli } from "../args.js"
import { contextLang, invocationLang, resolveCwd, withContext, type RunOptions } from "../context.js"
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
import { tr, type Lang } from "../i18n.js"

const MAX_EXPORT_ROWS = 200_000
const PAGE_SIZE = 1000

/** How many unpriced models the summary lists before it stops (EVO-G74). */
const MAX_UNPRICED_MODELS = 5

/** How many attribution tags `usage summary --by-tag` lists (EVO-G75). */
const MAX_TAG_BUCKETS = 10

/**
 * How many code points of a tag the breakdown prints (EVO-G75).
 *
 * A host may lawfully store a 256-character tag value, and a column sized by the
 * longest value would push the numbers off the screen. The cell is clipped for
 * **display only**: the stored value, the API and the CSV column keep every
 * character, and the trailing ellipsis says the cell is not the whole story.
 */
const MAX_TAG_DISPLAY_LENGTH = 48

/** Clip a tag for a table cell, by code points, with a visible ellipsis. */
function clipTag(text: string): string {
  const points = Array.from(text)
  return points.length <= MAX_TAG_DISPLAY_LENGTH ? text : `${points.slice(0, MAX_TAG_DISPLAY_LENGTH).join("")}…`
}

/**
 * Accept a plain date, an ISO timestamp or epoch milliseconds.
 *
 * A plain `--to` date means "the whole of that day", so it is advanced to the
 * start of the next day, which pairs with the repository's `ts < to` filter.
 *
 * `lang` is the *invocation* language (these errors are raised before the hub
 * opens): flag names and the value echoed back stay literal, only the prose is
 * localized.
 */
export function parseTime(input: string, end: boolean, flag: string, lang: Lang): number {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    if (Number.isNaN(date.getTime())) throw new CliUsageError(tr(lang, "usage.error.badDate", flag, input))
    if (end) date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) {
    throw new CliUsageError(tr(lang, "usage.error.expectsTime", flag, input))
  }
  return parsed
}

export function buildUsageQuery(parsed: ParsedCli, lang: Lang): UsageQuery {
  const query: UsageQuery = {}
  const from = flagString(parsed.values, "from")
  if (from) query.from = parseTime(from, false, "--from", lang)
  const to = flagString(parsed.values, "to")
  if (to) query.to = parseTime(to, true, "--to", lang)
  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
    throw new CliUsageError(tr(lang, "usage.error.fromAfterTo"))
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
      throw new CliUsageError(tr(lang, "usage.error.badStatus", status))
    }
    query.status = status
  }
  /**
   * `--tag feature=quant-backtest` filters by one attribution tag (EVO-G75).
   * Only the **first** `=` splits: a tag value may itself contain `=` (a
   * base64 blob, a URL), and splitting on the last one would truncate it.
   */
  const tag = flagString(parsed.values, "tag")
  if (tag) {
    const equals = tag.indexOf("=")
    const key = equals === -1 ? tag : tag.slice(0, equals)
    if (key.length === 0) throw new CliUsageError(tr(lang, "usage.error.badTag", tag))
    query.tag = key
    if (equals !== -1) query.tagValue = tag.slice(equals + 1)
  }
  return query
}

function startOfTomorrow(): number {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now.getTime() + 86_400_000
}

/** `--days` only fills a missing bound; explicit `--from`/`--to` always win. */
function applyDays(query: UsageQuery, parsed: ParsedCli, lang: Lang): UsageQuery {
  const days = flagNumber(parsed.values, "days", parsed.action?.usage, lang) ?? 30
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new CliUsageError(tr(lang, "usage.error.badDays", days))
  }
  const result: UsageQuery = { ...query }
  if (result.to === undefined) result.to = startOfTomorrow()
  if (result.from === undefined) result.from = result.to - days * 86_400_000
  return result
}

/**
 * `Range … → … · app=…[ · provider=… model=… status=…]`.
 *
 * Only the word `Range` is prose; `app=` / `provider=` / `model=` / `status=`
 * are key names a user can copy into a command, so they stay literal.
 */
function rangeLabel(query: UsageQuery, appId: string, lang: Lang): string {
  const from = query.from === undefined ? "-" : formatDate(query.from)
  const to = query.to === undefined ? "-" : formatDate(query.to - 1)
  const scope = query.appId ?? appId
  const filters = [
    query.providerId ? `provider=${query.providerId}` : null,
    query.model ? `model=${query.model}` : null,
    query.status ? `status=${query.status}` : null,
    // A tag is a key/value pair; `tag=key=value` keeps both halves visible.
    query.tag ? `tag=${query.tag}${query.tagValue === undefined ? "" : `=${query.tagValue}`}` : null,
  ].filter((item): item is string => item !== null)
  return tr(lang, "usage.range", from, to, scope, filters.length > 0 ? ` · ${filters.join(" ")}` : "")
}

function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces)
  return block
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n")
}

/**
 * The unpriced-coverage block (EVO-G74) that is appended to `usage summary`.
 *
 * It answers the one question a bare `Cost (USD) 0.0000` cannot: *is this cheap,
 * or is a pile of models simply unpriced?* — and turns the answer into a to-do
 * by naming the models and the exact `mik pricing set` line to fix each.
 *
 * **Silent when healthy.** With zero unpriced requests (which includes the
 * empty database and the all-priced install) this returns `[]`, so the default
 * output is byte-for-byte what it was before. A coverage banner that always
 * fires would be noise, and noise is what makes people stop reading.
 *
 * **Display-only.** It reads figures it does not recompute: no cost total,
 * no existing line and no ordering changes.
 *
 * Each ratio prints `part / total` next to the percentage, so the denominator
 * is checkable by hand instead of being taken on faith. Both sides come from
 * the same detail rows (`usage_daily_rollups` stores no pricing source), which
 * is why the printed totals are the block's own rather than a reprint of the
 * summary's.
 */
function unpricedLines(coverage: UnpricedCoverage, lang: Lang): string[] {
  if (coverage.requests === 0 || coverage.totalRequests === 0) return []
  const ratio = (part: number, total: number): string =>
    `${formatTokens(part)} / ${formatTokens(total)} (${formatPercent(total === 0 ? 0 : part / total)})`
  const lines = [
    tr(lang, "usage.summary.unpriced.title"),
    indent(
      formatKeyValues([
        [tr(lang, "usage.summary.unpriced.requests"), ratio(coverage.requests, coverage.totalRequests)],
        [tr(lang, "usage.summary.unpriced.tokens"), ratio(coverage.tokens, coverage.totalTokens)],
      ]),
      2,
    ),
  ]
  const models = coverage.models.slice(0, MAX_UNPRICED_MODELS)
  if (models.length > 0) {
    lines.push(`  ${tr(lang, "usage.summary.unpriced.topModels")}`)
    lines.push(
      indent(
        formatTable(
          [
            tr(lang, "usage.summary.unpriced.header.model"),
            tr(lang, "usage.summary.unpriced.header.requests"),
            tr(lang, "usage.summary.unpriced.header.tokens"),
          ],
          models.map((model) => [model.model, formatTokens(model.requests), formatTokens(model.tokens)]),
          ["left", "right", "right"],
        ),
        4,
      ),
    )
    for (const model of models) lines.push(`  ${tr(lang, "usage.summary.unpriced.fix", model.model)}`)
  }
  return lines
}

/**
 * The rollup caveat (EVO-G77) that follows the unpriced block.
 *
 * `unpricedCoverage()` is measured over `usage_events` because that is the only
 * table that records a `pricing_source`. `usage_daily_rollups` does not, so
 * every day `rollupAndPrune()` folded away is **unmeasurable**: it is excluded
 * from the block's numerator *and* denominator (correct — it must not be
 * guessed at), while `UsageSummary.requests` still counts it.
 *
 * That gap is silent by construction, which is the exact failure mode the G74
 * block exists to kill: `Cost 0.0000` plus no unpriced segment reads as "cheap
 * and healthy" even when a folded history was never priced at all. So whenever
 * `summary().requests` exceeds the detail rows the block could see, say so, and
 * say how many requests are affected.
 *
 * It is **not** the unpriced segment: it reports measurement scope, not
 * unpriced work, so it also fires when every retained row is priced (the case
 * where the blind spot would otherwise be completely invisible). It stays
 * silent when there is no gap at all, which keeps the output of a database that
 * never rolled up byte-for-byte identical to the pre-change build.
 */
function rollupGapLines(summaryRequests: number, detailRequests: number, lang: Lang): string[] {
  const folded = summaryRequests - detailRequests
  if (folded <= 0) return []
  return [tr(lang, "usage.summary.unpriced.rollupNote", formatTokens(folded))]
}

/**
 * The attribution-tag breakdown (EVO-G75) for `usage summary --by-tag`.
 *
 * This is the answer the existing output cannot give: with several business
 * features sharing one model layer, `byProvider`/`byModel` show *what* was
 * spent on, never *which feature* spent it. The table is one row per
 * `key=value` pair, most expensive first.
 *
 * Two honesty rules, both inherited from the G74/G77 precedent:
 * - it is **opt-in**, so the default summary stays byte-for-byte what it was;
 * - the note states the two things a reader could otherwise get wrong: a call
 *   with several tags is counted whole under each of them (the rows sum to more
 *   than the total), and a call with no tag is not in the table at all.
 *
 * An earlier draft printed a "N requests carry no tag" line computed as
 * `totalRequests - sum(bucket.requests)`. That number is **wrong** whenever any
 * call has two tags: the same request is then subtracted twice and the line
 * claims unattributed requests that do not exist. It was removed rather than
 * patched, because a second query for a footnote is not worth a concurrency
 * window between it and the table it annotates.
 *
 * Reserved (`_mik_`) keys never appear: they are reconciliation data written by
 * EVO-G73, not attribution.
 */
function tagBreakdownLines(buckets: readonly UsageBucket[], lang: Lang): string[] {
  const lines = [tr(lang, "usage.summary.tags.title")]
  if (buckets.length === 0) {
    lines.push(`  ${tr(lang, "usage.summary.tags.empty")}`)
    return lines
  }
  lines.push(
    indent(
      formatTable(
        [
          tr(lang, "usage.summary.tags.header.tag"),
          tr(lang, "usage.summary.tags.header.requests"),
          tr(lang, "usage.summary.tags.header.cost"),
        ],
        buckets.slice(0, MAX_TAG_BUCKETS).map((bucket) => [
          // Redacted for display: a label can come from a row written before
          // EVO-G75, when tags were stored unredacted (see `tagLabelForDisplay`).
          clipTag(tagLabelForDisplay(bucket.key)),
          formatTokens(bucket.requests),
          formatMoney(bucket.costUsd),
        ]),
        ["left", "right", "right"],
      ),
      2,
    ),
  )
  lines.push(`  ${tr(lang, "usage.summary.tags.note", RESERVED_TAG_KEYS.join(", "))}`)
  return lines
}

async function runSummary(parsed: ParsedCli, options: RunOptions): Promise<number> {
  // Flag validation happens before the hub opens, so it uses the invocation
  // environment; the rendered output uses the hub-level language below.
  const query = buildUsageQuery(parsed, invocationLang(options))
  return withContext(parsed, options, async (context) => {
    const lang = contextLang(context, options)
    const summary = context.hub.usage.summary(query)
    const unpriced = context.hub.usage.unpricedCoverage(query)
    context.io.out(rangeLabel(query, context.appId, lang))
    context.io.out("")
    context.io.out(
      formatKeyValues([
        [tr(lang, "usage.summary.requests"), formatTokens(summary.requests)],
        [tr(lang, "usage.summary.successes"), formatTokens(summary.successes)],
        [tr(lang, "usage.summary.failures"), formatTokens(summary.failures)],
        [tr(lang, "usage.summary.successRate"), formatPercent(summary.successRate)],
        [tr(lang, "usage.summary.cost"), formatMoney(summary.costUsd)],
        [tr(lang, "usage.summary.costRange"), `${formatMoney(summary.costLowUsd)} – ${formatMoney(summary.costHighUsd)}`],
        [tr(lang, "usage.summary.inputTokens"), formatTokens(summary.tokens.input)],
        [tr(lang, "usage.summary.outputTokens"), formatTokens(summary.tokens.output)],
        [tr(lang, "usage.summary.cacheRead"), formatTokens(summary.tokens.cacheRead)],
        [tr(lang, "usage.summary.cacheWrite"), formatTokens(summary.tokens.cacheWrite)],
        [tr(lang, "usage.summary.reasoning"), formatTokens(summary.tokens.reasoning)],
        [tr(lang, "usage.summary.cacheHitRate"), formatPercent(summary.cacheHitRate)],
        [tr(lang, "usage.summary.avgLatency"), formatDuration(summary.avgLatencyMs)],
        [tr(lang, "usage.summary.firstToken"), formatDuration(summary.firstTokenMs)],
      ]),
    )
    /**
     * Opt-in only (EVO-G75): without `--by-tag` nothing is added, so the default
     * output of every existing call is byte-for-byte what it was.
     */
    const tagLines = flagBool(parsed.values, "byTag") ? tagBreakdownLines(context.hub.usage.byTag(query), lang) : []
    // Appended last: every pre-existing line keeps its content and its order.
    const extra = [
      ...unpricedLines(unpriced, lang),
      // After the block: the caveat qualifies the block's scope, and it also
      // has to appear when the block itself is silent (EVO-G77).
      ...rollupGapLines(summary.requests, unpriced.totalRequests, lang),
      ...(tagLines.length > 0 ? ["", ...tagLines] : []),
    ]
    if (extra.length > 0) {
      context.io.out("")
      context.io.out(extra.join("\n"))
    }
    return 0
  })
}

async function runTrends(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const flagLang = invocationLang(options)
  const query = applyDays(buildUsageQuery(parsed, flagLang), parsed, flagLang)
  return withContext(parsed, options, async (context) => {
    const lang = contextLang(context, options)
    const points = context.hub.usage.trends(query)
    context.io.out(rangeLabel(query, context.appId, lang))
    context.io.out("")
    if (points.length === 0) {
      context.io.out(tr(lang, "usage.empty"))
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
      tr(lang, "usage.trends.total"),
      formatTokens(totals.requests),
      formatTokens(totals.input),
      formatTokens(totals.output),
      formatTokens(totals.cacheRead),
      formatMoney(totals.cost),
    ])
    context.io.out(
      formatTable(
        [
          tr(lang, "usage.trends.header.date"),
          tr(lang, "usage.trends.header.requests"),
          tr(lang, "usage.trends.header.input"),
          tr(lang, "usage.trends.header.output"),
          tr(lang, "usage.trends.header.cacheRead"),
          tr(lang, "usage.trends.header.cost"),
        ],
        rows,
        ["left", "right", "right", "right", "right", "right"],
      ),
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
    // Which claim this row's money is (EVO-G73): `provider` means the endpoint
    // reported the amount it billed, anything else is a computed estimate.
    event.cost.source,
    formatDuration(event.latencyMs),
  ])
}

async function runLogs(parsed: ParsedCli, options: RunOptions): Promise<number> {
  const flagLang = invocationLang(options)
  const query = buildUsageQuery(parsed, flagLang)
  const limit = flagNumber(parsed.values, "limit", parsed.action?.usage, flagLang) ?? 20
  const offset = flagNumber(parsed.values, "offset", parsed.action?.usage, flagLang) ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new CliUsageError(tr(flagLang, "usage.error.badLimit", limit))
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CliUsageError(tr(flagLang, "usage.error.badOffset", offset))
  }

  return withContext(parsed, options, async (context) => {
    const lang = contextLang(context, options)
    const page = context.hub.usage.query({ ...query, limit, offset })
    context.io.out(rangeLabel(query, context.appId, lang))
    context.io.out("")
    if (page.events.length === 0) {
      context.io.out(tr(lang, "usage.empty"))
      return 0
    }
    context.io.out(
      formatTable(
        [
          tr(lang, "usage.logs.header.ts"),
          tr(lang, "usage.logs.header.app"),
          tr(lang, "usage.logs.header.provider"),
          tr(lang, "usage.logs.header.model"),
          tr(lang, "usage.logs.header.status"),
          tr(lang, "usage.logs.header.input"),
          tr(lang, "usage.logs.header.output"),
          tr(lang, "usage.logs.header.cost"),
          tr(lang, "usage.logs.header.source"),
          tr(lang, "usage.logs.header.latency"),
        ],
        logRows(page.events),
        ["left", "left", "left", "left", "left", "right", "right", "right", "left", "right"],
      ),
    )
    context.io.out("")
    context.io.out(tr(lang, "usage.logs.showing", formatTokens(page.events.length), formatTokens(page.total), offset))
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
  const flagLang = invocationLang(options)
  const format = (flagString(parsed.values, "format") ?? "csv").toLowerCase()
  if (format !== "csv") {
    throw new CliUsageError(tr(flagLang, "usage.error.badFormat", format), parsed.action?.usage)
  }
  const query = buildUsageQuery(parsed, flagLang)
  const out = flagString(parsed.values, "out")
  const cwd = resolveCwd(options)

  return withContext(parsed, options, async (context) => {
    const lang = contextLang(context, options)
    const events = collectAll(query, context.hub.usage)
    const csv = usageCsv(events)
    if (out) {
      const target = resolve(cwd, out)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, csv, "utf8")
      context.io.out(tr(lang, "usage.export.wrote", formatTokens(events.length), target))
    } else {
      // The CSV itself is a data format with a fixed header: never localized.
      context.io.out(csv.replace(/\n$/, ""))
    }
    if (events.length >= MAX_EXPORT_ROWS) {
      context.io.err(tr(lang, "usage.export.truncated", formatTokens(MAX_EXPORT_ROWS)))
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
      throw new CliUsageError(tr(invocationLang(options), "usage.error.unknownAction", parsed.action?.name ?? ""), parsed.command?.usage)
  }
}
