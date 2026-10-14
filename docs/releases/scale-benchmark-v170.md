# EVO-G146 — million-row SQLite ledger scale benchmark (ARCH-011)

> Local candidate only. No push, no publish, no filesystem deletion. Baseline
> `afa81ec` (EVO-G145). Version remains 1.7.0.
>
> Reproduction: `node scripts/benchmark-scale.mjs` (add `--quick` for 100k rows,
> or `MIK_G146_ROWS=<n>`). Machine-readable result:
> `.tmp/g146/benchmark-scale.json` (gitignored).

## What was measured

The benchmark writes **1,000,000 usage events** through the **production write
path** — `UsageRepository.insert()`, i.e. the same code a host reaches through
`UsageService.record()` — on a disk-backed SQLite database opened with the
shipped pragmas (`journal_mode = WAL`, `busy_timeout = 5000`). Rows are spread
over 365 days across 4 providers and 8 models with mixed statuses, in batches of
10,000 rows per transaction.

Environment: `win32` x64, Node `v24.14.0`, 8 CPUs, `node:sqlite`.

## Results

| Metric | Value |
|---|---|
| Rows inserted | 1,000,000 (exactly once) |
| Batched WAL write throughput | **2,488 TPS** over 401,946 ms |
| Per-insert latency (µs) | p50 **306.5** · p90 **530.3** · p99 **1,907.7** · max **378,447.7** |
| 30-day aggregate, before fold | 157.636 ms (median of 15) |
| 30-day aggregate, after fold | **0.360 ms** (median of 15) |
| 365-day aggregate, before fold | 2,146.557 ms (median of 15) |
| 365-day aggregate, after fold | **2.507 ms** (median of 15) — gate is `< 15 ms` |
| Fold of 1,000,000 detail rows | 39,895 ms → 2,912 archive rows (reduction ×343.4) |
| Mixed concurrent read/write | 60 reads + 500 writes, **no deadlock**, 3,050 ms |

### Pre-fold 365-day query plan

```
SEARCH usage_events USING COVERING INDEX idx_usage_ts (ts>? AND ts<?)
```

So even before folding, a 365-day aggregate is a **covering-index range search**,
not an unindexed table scan.

### Post-fold 365-day query plan

```
SEARCH usage_daily_rollups USING INDEX sqlite_autoindex_usage_daily_rollups_1 (date>? AND date<?)
```

## What the numbers actually prove

- **The long-range aggregate answers from the fold table.** After the fold,
  `usage_events` holds **0** rows and `usage_daily_rollups` holds 2,912. A 365-day
  `summary()` still returns the full request count and the same integer
  micro-USD total as before the fold. If it read only the detail table it would
  have returned zero — so the numbers provably come from the archive.
- **Folding is conservative.** Pre-fold and post-fold summaries agree on request
  count and on integer micro-USD cost (`costUsd × 10^6`). The archive is keyed by
  `(date, app_id, source, provider_id, model)`, so its size is bounded by the
  calendar × dimensions (2,912 rows here), not by the detail row count.
- **No deadlock.** A second connection in a worker thread ran reads and writes
  concurrently against the same WAL database while the main thread wrote; both
  settled inside the watchdog with no errors.

## Limits of this evidence (read before quoting)

- The **table is `usage_daily_rollups`**, not `usage_daily_folds`. The latter is
  the planning-doc name (`docs/plans/architecture-improvement-plan.md`); the
  source (Schema v8) is authoritative.
- TPS and latency are **observed values on one Windows machine**, not a
  universal or hard-real-time guarantee. The per-insert `max` (378 ms) is a
  single tail outlier (SQLite checkpoint / GC), not a per-row bound — the p50/p90
  are the meaningful figures.
- The 365-day post-fold **plan check is a shape check** on the fold-table access
  path; the load-bearing proof that the production aggregate prefers the fold
  table is the **conservation-after-detail-deletion** gate above, not the plan
  string.
- The fold itself is a maintenance operation and is **not** free: ~40 s for 10^6
  rows. It is expected to run out-of-band (`usage.rollupAndPrune()`), not on the
  request path.
- The benchmark runs against `packages/mik/src` via `scripts/e2e/loader.mjs`
  (the same source loader the e2e suite uses), so it reflects the current tree,
  not a stale build.

## Gate summary

All ten internal gates pass (`result: OK`, `failures: 0`):

```
PASS  all rows inserted exactly once
PASS  detail row count matches the injected rows
PASS  the fold consumed every detail row
PASS  the fold produced a non-empty archive
PASS  the archive is bounded by days × dimensions, not by the detail row count
PASS  folding conserved the request count
PASS  folding conserved the integer cost totals
PASS  long-range (365d) aggregate answers in < 15 ms after the fold
PASS  the post-fold long-range plan reads usage_daily_rollups and not the detail table
PASS  the folded archive still returns the same request count for a 365d window
```
