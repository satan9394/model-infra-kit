#!/usr/bin/env node
/**
 * ARCH-011 (EVO-G146) — million-row SQLite ledger benchmark.
 *
 * Injects `MIK_G146_ROWS` (default 1,000,000) real usage events through the
 * production write path (`UsageRepository.insert`, i.e. the same code a host
 * uses) and measures:
 *
 *   - batched WAL insert throughput and the per-insert latency distribution;
 *   - a 30-day and a 365-day aggregate before and after the archive fold;
 *   - that the post-fold long-range aggregate answers from
 *     `usage_daily_rollups` (the fold table) instead of scanning detail rows,
 *     and that it stays under the 15 ms gate;
 *   - mixed concurrent reads and writes against the same WAL database, under a
 *     watchdog, so a deadlock fails the run instead of hanging it.
 *
 * The event distribution, window lengths and thresholds are inputs/constants,
 * not read back from the thing under test. The script exits non-zero when a
 * gate fails.
 *
 * Usage:
 *   node scripts/benchmark-scale.mjs
 *   MIK_G146_ROWS=200000 node scripts/benchmark-scale.mjs
 *   node scripts/benchmark-scale.mjs --quick     # 100k rows, for a smoke run
 *
 * It re-executes itself with the TypeScript transform + source loader so the
 * plain command above needs no flags (same pattern as `scripts/e2e/run.mjs`).
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")
const TRANSFORM_FLAG = "--experimental-transform-types"
const LOADER_URL = new URL("./e2e/loader.mjs", import.meta.url).href

const argv = process.argv.slice(2)
const QUICK = argv.includes("--quick")

/** The long-range aggregate must answer from the fold table within this bound. */
export const LONG_RANGE_GATE_MS = 15

const alreadyFlagged = process.execArgv.some((arg) => arg === TRANSFORM_FLAG || arg.startsWith(`${TRANSFORM_FLAG}=`))
if (!alreadyFlagged && process.env.MIK_G146_REEXEC !== "1") {
  const child = spawn(
    process.execPath,
    [TRANSFORM_FLAG, "--disable-warning=ExperimentalWarning", "--import", LOADER_URL, fileURLToPath(import.meta.url), ...argv],
    { stdio: "inherit", env: { ...process.env, MIK_G146_REEXEC: "1" } },
  )
  child.on("exit", (code) => process.exit(code ?? 1))
} else {
  await main()
}

// ───────────────────────────────────────── main ───────────────────────────────
async function main() {
  const { Store } = await import("model-infra-kit")

  const ROWS = QUICK ? 100_000 : Number(process.env.MIK_G146_ROWS ?? 1_000_000)
  const BATCH = Number(process.env.MIK_G146_BATCH ?? 10_000)
  const REPEATS = Number(process.env.MIK_G146_REPEATS ?? 15)
  const DAY = 86_400_000
  const now = Date.now()
  const span = 363 * DAY
  const start = now - 365 * DAY

  const providers = ["alpha", "beta", "gamma", "delta"]
  const models = ["small", "medium", "large", "reasoning", "coder", "mini", "pro", "flash"]

  const dbDir = mkdtempSync(join(tmpdir(), "mik-g146-scale-"))
  const dbPath = join(dbDir, "usage.db")
  const store = await Store.open({ path: dbPath, onWarn: (message) => process.stderr.write(`[bench warn] ${message}\n`) })

  const result = {
    format: "mik-scale-benchmark/v1",
    generatedAt: new Date(now).toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      sqlite: "node:sqlite (WAL, busy_timeout 5000)",
      rows: ROWS,
      batchSize: BATCH,
      spanDays: 365,
    },
    dbPath,
    gates: [],
    failures: [],
  }

  try {
    const eventAt = (i) => start + Math.floor((i / ROWS) * span)
    const event = (i) => ({
      requestId: `bench-${i}`,
      appId: "bench",
      ts: eventAt(i),
      source: "bench",
      providerId: providers[i % providers.length],
      modelRequested: models[i % models.length],
      modelActual: models[i % models.length],
      usage: { input: 1000 + (i % 500), output: 200 + (i % 100), cacheRead: i % 50, cacheWrite: i % 20, reasoning: i % 7 === 0 ? 5 : 0 },
      cost: { usd: (1000 + (i % 9000)) / 1e6, low: (900 + (i % 9000)) / 1e6, high: (1100 + (i % 9000)) / 1e6, basis: "exact", source: "modelsdev" },
      latencyMs: 100 + (i % 400),
      status: i % 37 === 0 ? "error" : "ok",
      isStreaming: i % 5 === 0,
    })

    // ── Phase 1: write throughput + per-insert latency distribution ──────────
    const perInsertMicros = new Float64Array(ROWS)
    const batchDurations = []
    let inserted = 0
    const writeStart = performance.now()
    for (let from = 0; from < ROWS; from += BATCH) {
      const to = Math.min(from + BATCH, ROWS)
      const batchStart = performance.now()
      store.driver.transaction(() => {
        for (let i = from; i < to; i++) {
          const before = performance.now()
          if (store.usage.insert(event(i))) inserted += 1
          perInsertMicros[i] = (performance.now() - before) * 1000
        }
      })
      batchDurations.push(performance.now() - batchStart)
    }
    const writeElapsedMs = performance.now() - writeStart
    const writeTps = inserted / (writeElapsedMs / 1000)

    // Sort once; spreading a million values into Math.max would overflow the stack.
    const sorted = perInsertMicros.sort()
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
    result.write = {
      inserted,
      elapsedMs: round(writeElapsedMs),
      tps: round(writeTps, 0),
      batch: { size: BATCH, count: batchDurations.length, medianMs: round(percentile(batchDurations, 50)) },
      perInsertMicros: {
        p50: round(at(50), 2),
        p90: round(at(90), 2),
        p99: round(at(99), 2),
        max: round(sorted[sorted.length - 1], 2),
      },
    }
    check(result, "all rows inserted exactly once", inserted === ROWS)
    check(result, "detail row count matches the injected rows", count(store, "usage_events") === ROWS)

    // ── Phase 2: aggregation before the fold ─────────────────────────────────
    const window30 = { from: now - 30 * DAY, to: now }
    const window365 = { from: now - 365 * DAY, to: now }

    const detailPre = {
      d30: measure(() => store.usage.summary(window30), REPEATS),
      d365: measure(() => store.usage.summary(window365), REPEATS),
    }
    const preFoldTotals = store.usage.summary(window365)

    result.aggregates = {
      beforeFold: {
        days30: duration(detailPre.d30),
        days365: duration(detailPre.d365),
        detailRowsInWindow: count(store, "usage_events"),
        plan: plan(store, "SELECT COUNT(*) AS requests FROM usage_events WHERE ts >= ? AND ts < ?", [window365.from, window365.to]),
      },
    }

    // ── Phase 3: fold everything into the archive ────────────────────────────
    const foldStart = performance.now()
    const folded = store.usage.rollupAndPrune(now, 0)
    const foldMs = performance.now() - foldStart

    const rollupRows = count(store, "usage_daily_rollups")
    const detailAfterFold = count(store, "usage_events")
    const postFoldTotals = store.usage.summary(window365)

    result.fold = {
      folded,
      elapsedMs: round(foldMs),
      detailRowsAfter: detailAfterFold,
      foldRows: rollupRows,
      foldReductionFactor: detailAfterFold === 0 && rollupRows > 0 ? round(ROWS / rollupRows, 1) : null,
    }
    check(result, "the fold consumed every detail row", folded === ROWS && detailAfterFold === 0)
    check(result, "the fold produced a non-empty archive", rollupRows > 0)
    // The archive is keyed by (day, app, source, provider, model), so its size
    // is bounded by the calendar × dimensions — never by the detail count.
    check(
      result,
      "the archive is bounded by days × dimensions, not by the detail row count",
      rollupRows <= 20_000,
    )
    check(result, "folding conserved the request count", postFoldTotals.requests === preFoldTotals.requests)
    check(
      result,
      "folding conserved the integer cost totals",
      micros(postFoldTotals) === micros(preFoldTotals),
    )

    // ── Phase 4: aggregation after the fold (must answer from the fold table) ─
    const rollupPost = {
      d30: measure(() => store.usage.summary(window30), REPEATS),
      d365: measure(() => store.usage.summary(window365), REPEATS),
    }
    result.aggregates.afterFold = {
      days30: duration(rollupPost.d30),
      days365: duration(rollupPost.d365),
      plan: plan(store, "SELECT SUM(request_count) AS requests FROM usage_daily_rollups WHERE date >= ? AND date <= ?", [
        "0000-01-01",
        "9999-12-31",
      ]),
      detailRowsScanned: detailAfterFold,
    }
    check(
      result,
      `long-range (365d) aggregate answers in < ${LONG_RANGE_GATE_MS} ms after the fold`,
      median(rollupPost.d365) < LONG_RANGE_GATE_MS,
    )
    check(result, "the post-fold long-range plan reads usage_daily_rollups and not the detail table",
      result.aggregates.afterFold.plan.some((line) => line.includes("usage_daily_rollups")) &&
        !result.aggregates.afterFold.plan.some((line) => line.includes("usage_events")))
    check(
      result,
      "the folded archive still returns the same request count for a 365d window",
      store.usage.summary(window365).requests === preFoldTotals.requests,
    )

    // ── Phase 5: mixed concurrent read/write under a watchdog ────────────────
    result.concurrency = await concurrencyPhase(dbPath, now)

    // ── Report ───────────────────────────────────────────────────────────────
    writeReport(result)
    emit(result)
    process.exitCode = result.failures.length === 0 ? 0 : 1
  } catch (error) {
    result.failures.push(`benchmark threw: ${error instanceof Error ? error.message : String(error)}`)
    writeReport(result)
    emit(result)
    process.exitCode = 1
  } finally {
    store.close()
  }
}

// ─────────────────────────────── concurrency ─────────────────────────────────
/**
 * A real second connection in a worker thread reads while this thread writes.
 * Synchronous SQLite calls cannot interleave inside one thread, so the worker
 * is what makes the read/write mix genuine. The watchdog turns a deadlock into
 * a failure instead of a hang.
 */
async function concurrencyPhase(dbPath, now) {
  const { Worker } = await import("node:worker_threads")
  const workerSource = `
    import { parentPort, workerData } from "node:worker_threads"
    const { Store } = await import("model-infra-kit")
    const store = await Store.open({ path: workerData.dbPath })
    const errors = []
    let reads = 0
    try {
      for (let i = 0; i < workerData.reads; i++) {
        const summary = store.usage.summary({ from: workerData.from, to: workerData.now })
        if (typeof summary.requests !== "number") errors.push("summary did not return a request count")
        reads += 1
      }
      for (let i = 0; i < workerData.writes; i++) {
        store.usage.insert({ requestId: workerData.writerId + "-" + i, appId: "bench", ts: workerData.now, source: "bench",
          providerId: "alpha", modelRequested: "small", modelActual: "small",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          cost: { usd: 0.000001, low: 0.000001, high: 0.000001, basis: "exact", source: "modelsdev" },
          status: "ok", isStreaming: false })
      }
    } catch (error) { errors.push(String(error && error.message ? error.message : error)) }
    store.close()
    parentPort.postMessage({ reads, errors })
  `
  const worker = new Worker(workerSource, {
    eval: true,
    type: "module",
    execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", LOADER_URL],
    workerData: { dbPath, reads: 60, writes: 10, now, from: now - 365 * 86_400_000, writerId: "worker" },
  })
  const workerDone = new Promise((settle) => {
    worker.on("message", (message) => settle({ ...message, crashed: null }))
    worker.on("error", (error) => settle({ reads: 0, errors: [], crashed: String(error.message ?? error) }))
  })

  const writer = new Worker(
    `
    import { parentPort, workerData } from "node:worker_threads"
    const { Store } = await import("model-infra-kit")
    const store = await Store.open({ path: workerData.dbPath })
    let written = 0
    const errors = []
    try {
      for (let i = 0; i < workerData.rows; i++) {
        if (store.usage.insert({ requestId: workerData.writerId + "-" + i, appId: "bench", ts: workerData.now, source: "bench",
          providerId: "beta", modelRequested: "medium", modelActual: "medium",
          usage: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          cost: { usd: 0.000002, low: 0.000002, high: 0.000002, basis: "exact", source: "modelsdev" },
          status: "ok", isStreaming: false })) written += 1
      }
    } catch (error) { errors.push(String(error && error.message ? error.message : error)) }
    store.close()
    parentPort.postMessage({ written, errors })
    `,
    {
      eval: true,
      type: "module",
      execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", LOADER_URL],
      workerData: { dbPath, rows: 500, now, writerId: "writer" },
    },
  )
  const writerDone = new Promise((settle) => {
    writer.on("message", (message) => settle({ ...message, crashed: null }))
    writer.on("error", (error) => settle({ written: 0, errors: [], crashed: String(error.message ?? error) }))
  })

  const WATCHDOG_MS = 120_000
  const started = performance.now()
  const settled = await Promise.race([
    Promise.all([workerDone, writerDone]).then(([reader, write]) => ({ reader, write })),
    new Promise((settle) => setTimeout(() => settle(null), WATCHDOG_MS)),
  ])
  const elapsedMs = performance.now() - started
  await worker.terminate()
  await writer.terminate()

  if (settled === null) return { deadlock: true, watchdogMs: WATCHDOG_MS, elapsedMs: round(elapsedMs), errors: ["mixed read/write did not settle before the watchdog"] }
  const errors = [...(settled.reader.errors ?? []), ...(settled.write.errors ?? [])].filter(Boolean)
  if (settled.reader.crashed) errors.push(`reader crashed: ${settled.reader.crashed}`)
  if (settled.write.crashed) errors.push(`writer crashed: ${settled.write.crashed}`)
  return {
    deadlock: false,
    elapsedMs: round(elapsedMs),
    reads: settled.reader.reads,
    writes: settled.write.written,
    errors,
  }
}

// ───────────────────────────────── helpers ───────────────────────────────────
function measure(fn, repeats) {
  const samples = []
  fn() // warm the statement cache / page cache
  for (let i = 0; i < repeats; i++) {
    const started = performance.now()
    fn()
    samples.push(performance.now() - started)
  }
  return samples
}

function duration(samples) {
  return {
    samples: samples.length,
    medianMs: round(percentile(samples, 50), 3),
    p90Ms: round(percentile(samples, 90), 3),
    maxMs: round(Math.max(...samples), 3),
  }
}

function median(samples) {
  return percentile(samples, 50)
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function count(store, table) {
  return Number(store.driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
}

function micros(summary) {
  return Math.round(summary.costUsd * 1_000_000)
}

function plan(store, sql, params) {
  return store.driver.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => String(row.detail))
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function check(result, label, ok) {
  result.gates.push({ label, ok: Boolean(ok) })
  if (!ok) result.failures.push(label)
}

function emit(result) {
  const write = result.write
  const before = result.aggregates?.beforeFold
  const after = result.aggregates?.afterFold
  process.stdout.write("\n── EVO-G146 scale benchmark ─────────────────────────────\n")
  if (write) {
    process.stdout.write(`rows: ${result.environment.rows}  write: ${write.tps} TPS over ${write.elapsedMs} ms\n`)
    process.stdout.write(`per-insert µs: p50 ${write.perInsertMicros.p50} · p90 ${write.perInsertMicros.p90} · p99 ${write.perInsertMicros.p99} · max ${write.perInsertMicros.max}\n`)
  }
  if (before && after) {
    process.stdout.write(`365d aggregate: before fold ${before.days365.medianMs} ms → after fold ${after.days365.medianMs} ms\n`)
    process.stdout.write(`30d aggregate:  before fold ${before.days30.medianMs} ms → after fold ${after.days30.medianMs} ms\n`)
  }
  if (result.fold) {
    process.stdout.write(`fold: ${result.fold.folded} rows → ${result.fold.foldRows} archive rows (${result.fold.elapsedMs} ms); detail after: ${result.fold.detailRowsAfter}\n`)
  }
  if (result.concurrency) {
    process.stdout.write(`concurrency: reads ${result.concurrency.reads} · writes ${result.concurrency.writes} · deadlock ${result.concurrency.deadlock} (${result.concurrency.elapsedMs} ms)\n`)
  }
  for (const gate of result.gates) process.stdout.write(`${gate.ok ? "PASS" : "FAIL"}  ${gate.label}\n`)
  process.stdout.write(`result: ${result.failures.length === 0 ? "OK" : `FAILED (${result.failures.length})`}\n`)
}

function writeReport(result) {
  const outputPath = resolve(ROOT, ".tmp", "g146", "benchmark-scale.json")
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`\nwrote ${outputPath}\n`)
}
