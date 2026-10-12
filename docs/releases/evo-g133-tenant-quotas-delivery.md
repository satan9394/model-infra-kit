# EVO-G133 local tenant quota delivery — 2026-10-11

Baseline: local `main` at `e7c3933f3f3427a92e075fbc6124f5042d61e8f1`, version 1.7.0.
Local delivery accepted and closed. Implementation commit: `cd9b3b9`.
No push, publish, remote CI, dependencies, filesystem deletion or schema migration.

## Changes and scope

- `quota/rate-limiter.ts`: exact trailing-minute RPM/TPM reservation ring,
  monotonic rollback clamp, Fenwick sums and indexed retry/partial expiry,
  constant-time full-window expiry. Synchronous parent/child probe/commit.
- `quota/hierarchy.ts`: server-configured organization/application membership,
  shared parent rate/spend limits, bounded identifiers/nodes/memory, BigInt budgets.
- Server: optional `ServerOptions.quotas`, authenticated app guard on all three
  generation routes, positive integer retry/reset headers, zero-cost
  `RATE_LIMITED` audit rows, scoped `GET /api/quotas`, additive status/types/OpenAPI.
  Unknown tenants and ledger-disabled configurations fail closed; budget bypass
  privileges do not bypass tenant quotas.
- Ledger: read authoritative Schema v7 cost columns through SQL integer sums
  cast to text, then BigInt aggregation; retained daily rollups are included.
  No conversion from USD floats for quota totals. SQL overflow fails before dispatch.
- Dashboard: `/quotas`, compact existing overview panel and navigation,
  21 matching bilingual keys, exact integer micros labels/progress, bounded audit
  list and visibility-aware polling. Existing DOM anchors retained.

## Eight-step loop and review

Required workflow SKILL, core-loop, verification and Codex adapter were read in full.
The existing card defined the single-card bounded Mission and frontend scope.
Requirements/design/task alignment preceded implementation. Focused tests and
typechecks preceded a separate read-only evaluator; no reviewer edited files.

Initial review rejected wrong output-limit fields, native documents/completion
multipliers, linear ring scans and reload with disabled accounting. Re-audit found
provider-side context expansion. Fixes require route-specific output ceilings and
reject media, `n != 1`, stored context references, provider tools/functions under
hard TPM; reject disabled recording on reload; index all large-ring paths.
Final independent **code review PASS**. The timing criterion was subsequently
accepted by the user as described below.

Adversarial evidence: 21 focused tests; 1000 simultaneous admissions; exact expiry,
ring wrap, UTC rollover/rollback, oversized IDs, sibling isolation, no upstream call
on rejection, restart persistence, zero-cost audits and integer totals above JS
safe-number precision. A 10000-operation reference test runs in the suite; the
independent evaluator additionally matched 100000 randomized operations.
Evidence: `.tmp/g133/review.md`, `benchmark.json`, ordered gate logs and `verification.json`.

## Accepted performance criterion and observed outliers

Runnable check: `node scripts/quota-benchmark.mjs`.
The corrected check measures admission, full-capacity TPM denial, and 60 separately
filled 100000-entry rings for full expiry, excluding setup and the first ten expiry
warm-ups. Observed maximum batch mean **3.008 microseconds**; individual measured
expiry samples reached **8.4 microseconds**. This is evidence for a warmed mean,
not a universal every-call bound. The original strict **every call <5 microseconds**
requirement was not met. The user explicitly approved the revised DoD:
**"Accept measured mean <5µs and document individual outliers"**. The accepted
criterion is the reproducible warmed mean <5 microseconds; individual outliers
remain disclosed, with no hard-real-time guarantee. This resolves the acceptance
gap and closes EVO-G133 without changing implementation or benchmark thresholds.

The initial linear implementation independently measured 497.3072 microseconds mean
for TPM denials and 5300.2 microseconds for full expiry. After indexing, the first
corrected benchmark still averaged 8.168 microseconds for true full-ring expiry;
the constant full-expiry path reduced the final recorded mean to 3.008.

## Functional limits

Rates are local to one server/process and reset on restart; durable recorded spend
survives restart. Budgets block new admission at recorded spend, so already admitted
requests and unknown pricing can cross a final-invoice threshold. Existing historical
rollups retain local-date allocation precision. Hard TPM uses conservative text-byte
reservations plus a route-specific output ceiling, without refunds. Provider-specific
tokenizers or providers ignoring ceilings cannot be guaranteed by this guard.
Quota configuration is injected in memory; CLI/JSON editing and quota config reload
are outside the card. No Redis or distributed/shared rate enforcement is introduced.

## Final mechanical gates

All commands ran in this order and exited 0; only LC_ALL/LANG were switched and
MIK_LANG was absent. Full source gates followed the final production edit.

| Gate | Evidence | Seconds |
| --- | --- | ---: |
| Dashboard then core typecheck | 0 errors in both | 9.294 / 11.774 |
| `LC_ALL=LANG=en_US.UTF-8 pnpm exec vitest run` | 1191/1191, 77 files | 54.825 |
| `LC_ALL=LANG=zh_CN.UTF-8 pnpm exec vitest run` | 1191/1191, 77 files | 52.651 |
| `pnpm --filter @mik/dashboard test` | 79/79 | 4.862 |
| `node scripts/e2e/run.mjs` | 12/12 PASS, dashboard production build | 92.398 |
| `node scripts/release/check-release-battery.mjs` | installed tarball battery PASS | 65.588 |

Installed exports remain exact root42 / auto2 / cli29 / server11, nine targets.
Additional installed quota smoke: real upstream call succeeds once, parent spend
reaches3 micros, next call429 with positive retry, one zero-cost audit, upstream
call count remains1. Command: `node .tmp/g133/installed-quota-smoke.mjs`, exit0.
Candidate retained at
`C:/Users/SATANC~1/AppData/Local/Temp/mik-release-battery-FNZoaF/candidate/model-infra-kit-1.7.0.tgz`;
SHA-1 `d4623de9d1d93d7d3e91b4f94a5d4de9d64ad227`.

## Browser and local hygiene

Actual in-app browser: English desktop quota meters and Chinese 390px view,
application daily 25/50 micros, organization monthly 25/100, zero-cost audit reason;
scrollWidth375 <= viewport390. Existing overview-cost-span exists; compact quota
panel renders; console error list empty. Screenshots: `.tmp/g133/quotas-en.png`,
`quotas-zh-mobile.png`, `overview-zh.png`. Viewport and original Chinese language
restored. Successful tab closed; first connection-refused tab could not be re-bound
because its browser-generated data URL was policy-blocked. Preview ports53210/53211
have no remaining listeners. Preview backend used a built candidate before later
security/performance-only repairs; UI schema and layout were unchanged thereafter.

`clean: false` retained. Final gates use the existing artifact-retention preload;
temporary databases/logs/tarballs remain. Task card, BOARD, HANDOVER and bounded
state follow their existing local-ignore policy. All source/test/docs changes are
explicitly staged; no `git add -A`. The acceptance follow-up changes documentation
only; prior source gates remain applicable. Standby follows the local commits;
push/publish still require separate human release authorization.
