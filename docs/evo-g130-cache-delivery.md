# EVO-G130 — normalized local cache and savings ledger

Delivered on local `main`, based on `8e94ea5dd9e1a4410cb5334a486ca95aeaf05f84`.
Version stays 1.6.0. No push, publish or remote CI was performed.

## Implementation

- `cache/normalizer.ts`: deterministic SHA-256 key over normalized messages, JSON and sorted tool schemas. JSON string values and array order remain significant. Eligibility requires temperature 0 or explicit `cache: true`; `cache: false` and `X-Mik-No-Cache: true` bypass. Custom/auth headers, secret-bearing content, unsupported content and executable tools bypass conservatively.
- `cache/lru.ts`: memory LRU plus SQLite persistence, fixed write-time TTL (24h default), maximum entries (10,000 default), isolated provider/model/app/config namespaces and cloned values. Shared validation serves embedded configuration, CLI and hot reload.
- `hub.ts` and OpenAI HTTP pipeline: completed generate/stream responses can be replayed without invoking the upstream or modifying QoS observations. Hits preserve text, tool calls and usage, record a fresh attribution event, and return zero actual cost/latency/TTFT markers. Errors, incomplete streams, executed tools and fallback responses do not populate the primary cache. Raw forwarding and `mik.fetch` remain outside this cache.
- Integer pricing and repository accounting: local savings price the full baseline input/output with existing BigInt tier arithmetic, excluding provider cache discount while retaining batch/time pricing. Unknown pricing yields zero savings. HTTP usage reports cannot spoof the local-hit tag.
- Overview, traces, waterfall and request logs: local request hit ratio, exact micro-dollar savings and localized green zero-ms badges. A local hit replaces the provider-cache miss label. DTOs and OpenAPI are extended additively.

## Ledger and contract boundaries

The baseline Schema v6 did not contain the requested physical event savings
column. Schema **v7** additively creates `usage_events.cache_savings_micros
INTEGER` and backfills immutable legacy savings tags. Existing v6 cost columns
remain authoritative; their meaning and values do not change. Event summaries,
daily folding and archive monetary conservation checks use the integer column.
The archive checksum field list itself is unchanged.

The real upstream integration fixture proves this integer ledger:

| Event | Actual cost (micro-USD) | Savings (micro-USD) |
|---|---:|---:|
| First provider call, with provider cache discount | 29 | 6 |
| Local replay of complete baseline usage | 0 | 35 |
| Combined summary | 29 | 41 |

`localCacheHitRate` is local hits divided by **all retained detail requests**,
including ineligible requests. Archived requests leave this denominator.
The existing `cacheHitRate` remains provider cached-input tokens / input tokens.
`cacheSavingsMicros` includes both provider discounts and full local savings.
Zero-ms replay fields describe replay semantics, not a wall-clock guarantee.
Contracts are recorded in `docs/interfaces.md`.

## Final ordered gates

All gates below ran after the final cache-label correction, in this order,
and exited 0. Locale runs inject only `LC_ALL` and `LANG`; `MIK_LANG` is absent.

| Command | Evidence | Duration |
|---|---|---:|
| `pnpm --filter @mik/dashboard typecheck` | 0 errors | 4.427s |
| `pnpm --filter model-infra-kit typecheck` | 0 errors | 11.031s |
| `LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 pnpm exec vitest run` | 1,129/1,129; 71 files | 49.095s |
| `LC_ALL=zh_CN.UTF-8 LANG=zh_CN.UTF-8 pnpm exec vitest run` | 1,129/1,129; 71 files | 53.418s |
| `pnpm --filter @mik/dashboard test` | 75/75 | 5.122s |
| `node scripts/e2e/run.mjs` | 12/12 PASS | 67.834s |

Local evidence: `.tmp/g130/verification.json`, `final-gates.ps1` and corresponding
`*-final.log` files. The locale-prefix notation above describes environment
injection; the runnable PowerShell script applies it directly.

Additional checks:

- `pnpm exec vitest run packages/mik/test/cache-normalizer.test.ts packages/mik/test/cache-gateway.test.ts --reporter=verbose`: **15/15**, two files, final focused log `cache-focused-final.log`. Includes no-upstream replay, SSE, bypass, persistence, app isolation and safe tool-call structure.
- `pnpm --filter model-infra-kit build`: PASS, 6.941s (`build.log`). E2E also rebuilt dashboard production output.
- `node --import ./scripts/e2e/loader.mjs scripts/cache-benchmark.mjs`: warmed 20,000-call small fixture average **44.2263 microseconds**, below 50 (`benchmark.log`). This is an observed average under local load, not a per-call upper bound or arbitrary-size-prompt guarantee.
- Local invariant probe: all **551** previous keys/values intact in each dictionary, four additions each, key/placeholder parity, existing DOM anchors, `clean: false`, local `main`; PASS. `git diff --check`: PASS.

## Rendered verification and cleanup

Production dashboard at `http://127.0.0.1:3210/` (the actual overview route)
and `/traces` used a real local mock upstream via the gateway at port 3211.
Three deterministic requests produced two hits: **66.7%, 2/3**, **35 micro-USD
spent**, **70 micro-USD saved**. English and Chinese overview/trace views showed
the exact values, zero-cost/zero-ms replay nodes and green badges without a
contradictory miss label. Final browser console error list was empty.

Screenshots: `.tmp/g130/overview-{en,zh}-final.png` and
`.tmp/g130/traces-{en,zh}-final.png`. English was restored; the existing dark
theme was retained. No responsive-width claim is made for this delivery.
The successful temporary tab was closed. Binding the earlier failed-navigation
tab was blocked by the browser's data-URL policy, so its cleanup was not confirmed.
After verifying command-line and port ownership, only preview PIDs 26472 and
25324 were stopped; ports 3210/3211 and final E2E dashboard/CLI ports
64449/51569 had no listeners. Scratch artifacts were retained; no files deleted.

## Development deviations and review

Initial full regression exposed three stale schema-version/archive expectations;
these were updated to the additive v7 and retained-request contract. Subsequent
targeted and complete gates passed. Browser inspection found the contradictory
cache-miss label; it was corrected, covered by rendered assertions, and the
entire ordered gate sequence rerun. Initial `/overview` navigation was incorrect;
verification used the existing `/` route. Preview source loading required Node's
experimental transform-types option for existing parameter-property syntax.

An independent cache-review worker could not complete because of an account
usage limit. This delivery has primary-agent inspection and mechanical/browser
evidence, **no independent-review PASS**. Remote platform CI and installed
published-package verification were not run in this local-only task.

Only EVO-G130 is closed. Local handover, task card, board and bounded state
are updated; await human instructions for any publication or subsequent card.
