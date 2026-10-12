# EVO-G134 webhook notification bus delivery

Delivered2026-10-11 on local main, baseline c6dddf363c280c967fd267d793f48258630bd679. Version remains1.7.0; no push, publish, remote CI, new dependencies or filesystem deletion. Local candidate only.

## Eight-step closure

1. **Understand:** read the entire required personal-dev-workflow skill plus core-loop, verification and adapter-codex references before implementation; inspected SPEC, HANDOVER, BOARD, card, accounting/server/config call chains. Clean baseline confirmed.
2. **Design:** four events USAGE_RECORDED/BUDGET_EXCEEDED/FAILOVER_TRIGGERED/RATE_LIMITED; process-local trusted host configuration and env-only signing references in CLI files; timestamp-bound HMAC-SHA256; Schema v7 integer wire amounts; bounded asynchronous delivery and cancellation.
3. **Align card:** card's old CACHE_SAVINGS_MILESTONE replaced by the user's RATE_LIMITED; dashboard monitoring requirement retained. No Redis/RabbitMQ or dependencies. User explicitly accepted structural no-wait plus measured CPU scheduling overhead instead of impossible absolute0ms overhead. Mission and bounded state recorded locally.
4. **Implement:** deferred bus and dispatcher, committed-write hook covering embedded generate/stream/fetch/HTTP/report/quota, failed streaming fallback tags, provider429 mapping, hard-budget rejection alert; admin status/test routes and OpenAPI; CLI/reload references; bilingual dashboard monitor. With no configured webhooks, no accounting observer or deferred ledger query is added.
5. **Review:** independent read-only reviewer identified missing failed-stream fallback events, provider429 code mismatch and retirement lifetime leak. All repaired; final focused24/24 exit0 independently reproduced. Later URL-helper extraction and installed-smoke polling race also independently reviewed PASS. Review evidence: .tmp/g134/review.md.
6. **Adversarial repair:** real30s hanging peer leaves embedded/streaming/HTTP responses completing independently; close cancels immediately without awaiting peer. Exact1/2/4s retry schedule yields4 total attempts;100 dead letters,1000 total outstanding jobs,4 active deliveries and64KiB bodies cap growth. Expired/future/tampered signatures reject. Duplicate/disabled writes do not notify; v7 values beyond Number precision remain exact strings. Failed-stream fallback, provider429 and retired initial external hub cancellation covered. Red evidence and fixture corrections retained below.
7. **Final gates:** all required gates executed in order after production repairs, exit0. Environment only switches LC_ALL/LANG; MIK_LANG absent. Existing retention preload preserves test artifacts; clean:false unchanged.
8. **Record/hand off:** this report, package README/contract/CHANGELOG, local task/BOARD/HANDOVER and state updated. Commit subject: feat: add asynchronous signed usage webhooks (EVO-G134). Final commit SHA is in Git and local HANDOVER; no self-referential commit hash in this committed report. Stop after this card; human push/publish gate retained.

## Ordered final evidence

| Gate | Result | Seconds |
|---|---|---:|
| pnpm --filter @mik/dashboard typecheck (zh_CN.UTF-8) | exit0 | 3.273 |
| pnpm --filter model-infra-kit typecheck (zh_CN.UTF-8) | exit0 | 8.750 |
| pnpm exec vitest run (en_US.UTF-8) | exit0 | 46.381 |
| pnpm exec vitest run (zh_CN.UTF-8) | exit0 | 53.165 |
| pnpm --filter @mik/dashboard test (zh_CN.UTF-8) | exit0 | 4.114 |
| node scripts/e2e/run.mjs (zh_CN.UTF-8) | exit0 | 21.011 |
| node scripts/release/check-release-battery.mjs (zh_CN.UTF-8) | exit0 | 59.681 |

Core en/zh each **1215/1215,80 files**. Dashboard **80/80**. E2E **12/12 PASS**. Installed release battery **PASS**, runtime exports unchanged root42/auto2/cli29/server11. Installed G134 smoke independently computes node:crypto HMAC, rejects reader403, accepts test202, receives2 events and exact costMicros="3" with delivered2 and no secret in payload/status.

Reproduce ordered gates with .tmp/g134/ordered-gates.mjs; individual required commands and timings are in .tmp/g134/verification.json and01–07 logs. Focused command: pnpm exec vitest run packages/mik/test/events-bus.test.ts packages/mik/test/events-webhook.test.ts packages/mik/test/events-integration.test.ts. Shared graph/server/webhook repair check93/93 exit0.

Scheduling benchmark: node --import ./scripts/e2e/loader.mjs scripts/webhooks-benchmark.mjs --json. Twenty warmed samples of900 bus emits each: mean0.118917µs/call, max batch mean0.318333µs. Measures bus enqueue CPU, not end-to-end generation overhead or a universal hard real-time limit. Main-chain no-await is structurally reviewed and independently reproduced with real hanging-peer tests.

Candidate tgz: C:/Users/SATANC~1/AppData/Local/Temp/mik-release-battery-jDMmMH/candidate/model-infra-kit-1.7.0.tgz; independent SHA1 **835cf1090ff5ec6c200a5763430411792fd3d4f0**. Battery clean room and all fixture artifacts retained.

## Browser evidence

Real built hub on3211 with local failing receiver, Next dev3210: English desktop subscriptions/counters/dead letters; test button gives queued status then second failed record. Chinese390px mobile renders correctly; document scrollWidth375<=390; console errors empty. Existing cost anchors untouched. Screenshots .tmp/g134/desktop-en.png and mobile-zh.png; details .tmp/g134/browser-evidence.json. Language restored to English and existing dark theme retained; viewport reset and temporary tab closed. Verified process command lines before stopping only this preview's1792/23236/22680. Final3210/3211/E2E61193/61222 have no listeners (earlier51514/51046/56947 also checked).

## Retained failures and deviations

- First fixture used Store's adapter constructor with a DB string; changed test to DatabaseSync. No product defect; integration-first.log retained.
- Initial independent negative tests found failed-stream fallback tags missing. Fixed at shared recordOnce plus bridge-error write; audit-red.log retained.
- Reload negative fixture initially omitted injected KEY, causing configuration refusal; fixed only fixture env. Valid deliberate cancellation-removal probe then successfully reloaded and failed closed-state assertion: lifecycle-red.log. Restored cancellation and passed.
- Receiver receipt count could include a previous canceled delivery, so exact amount test now selects requestId. repair-green.log failure retained; subsequent24/24 and both full locales pass.
- First full en gate:1213 passed/2 failed, import graph cycle and exact OpenAPI path list. Extracted unchanged literal-address utility for both callers and updated route contract. core-en-first-red.log and verification-first.json retained. Full ordered run restarted from step1 and all gates pass.
- Independent installed-smoke review found receipt count can precede delivered counter; final smoke separately polls delivered with a bounded deadline.
- Configuration is trusted host/env-reference only; dashboard shows subscriptions/status rather than editing signing secrets or arbitrary destinations. POST test intentionally ignores client body and targets configured usage subscribers.

## Operational limits

Best-effort bounded in-memory delivery: overload increments dropped; close discards unfinished deliveries; restart loses queued jobs/dead letters. A row pruned before deferred v7 lookup cannot notify. Durable reconciliation remains the SQLite ledger. Generic errors and status omit payloads, URLs and secrets. HTTP redirects are not followed and fetch redirect rejection follows bounded network-error retries;4xx is terminal. Receiver must deduplicate event id in addition to timestamp-window/timing-safe signature checks. Notifications on a shared hub share the server lifetime; retirement or any server.close() closes them. No remote three-platform CI or public-package validation is claimed.

Next: standby. Local commit authorized; push and publication require a separate human instruction.

Final package documentation readback: repeated all ordered gates after final README and whitespace edits; actual candidate package/README.md contains the async webhook section and env secretRef instructions. Earlier all-green logs retained as *-before-docs.log; final verification.json identifies the delivered snapshot. git diff --check passes.
