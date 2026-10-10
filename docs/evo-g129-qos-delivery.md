# EVO-G129 delivery — 2026-10-10

Local main implementation based on `f47ba2534f34d151e32c260a67d022cef798e677`,
version remains 1.6.0. No push, npm publication, remote CI or file deletion.

Changes: bounded in-memory QoS ring, RTT/observed-first-output EWMA, real window
variance, success/failure score, adaptive smooth weighted scheduling, per-attempt
SDK and forwarding feedback, CLI/reload configuration, admin-only redacted QoS
API and bilingual polling badges on provider/model cards. Static routing,
priority tiers, FIFO capacity, circuit and replay protection remain covered.
Contract and configuration example: [interfaces](interfaces.md#evo-g129--adaptive-channel-qos-local-main).

## Verification

All final commands exited 0; raw records and logs are retained locally in
`.tmp/g129/verification.json` and its named `.log` files.

| Gate | Result |
|---|---|
| Dashboard / core typechecks | 0 errors, 2.359s / 6.025s |
| Root `pnpm exec vitest run`, en_US.UTF-8 | 1,114/1,114, 69 files, 40.016s |
| Root `pnpm exec vitest run`, zh_CN.UTF-8 | 1,114/1,114, 69 files, 44.739s |
| Dashboard `node:test` | 75/75, 5.200s |
| `node scripts/e2e/run.mjs` | 12/12 PASS, 113.705s including dashboard build |
| Core tsdown build | PASS, 5.098s; `clean: false` retained |
| Built dist QoS smoke | root 42 exports; adaptive generate, sampled channel and API 200 |

The gate runner injects only LC_ALL/LANG for locale selection, leaving MIK_LANG
absent. Reproduce final gates from the repository root in their task-card order.
Root Vitest configuration now reuses the core timeout policy and selects core
tests; the dashboard remains a separate Node test gate.

Tracker benchmark:
`node --import ./scripts/e2e/loader.mjs scripts/qos-benchmark.mjs`.
Final warmed mean sampling+weighting **0.211639µs**, maximum of 100 individually
timed updates **0.5µs**, maximum batch average **6.2155µs/call**. These are measured
results on this machine, not a universal hard real-time guarantee.

Browser verification used a named local mock fixture with actual 100/800ms
delayed responses: healthy/reduced-weight badges, both languages, dark desktop
and light 390px provider/model layouts, no browser console errors. Screenshots:
`.tmp/g129/providers-en.png`, `models-zh.png`,
`providers-zh-390-light.png`, `models-zh-390-light.png`. Provider document width
375px at a 390px viewport: no global horizontal overflow. Temporary viewport and
language/theme preferences were restored; the tab was closed. Only identified
preview processes were stopped; preview/E2E ports were checked without listeners.

Invariant check: all **540 existing keys and values** in each dictionary intact,
11 additions each; existing literal DOM test anchors intact; no store/pricing
changes. No schema or monetary aggregation changes.

## Deviations and failed attempts

- Card path `router/failover.ts` does not exist. Integrated existing
  `router/load-balancer.ts`, `router/circuit-breaker.ts` and `hub.ts` callers.
- Jitter is actual population variance (`jitterVarianceMs2`) and standard
  deviation (`jitterMs`) rather than a single absolute residual. Missing TTFT is
  null. Omitted adaptive base weights default to 100 to permit integer reduction.
- Initial root Vitest run scanned dashboard Node tests and retained intentional
  red fixtures, used a 5s default timeout, and found the omitted exact OpenAPI
  contract path. Added a root config reusing the existing 30s core policy and
  updated the exhaustive path contract; both full locale gates then passed.
- Initial standalone tracker probe hit Node's parameter-property strip limit;
  explicit fields fixed the new classes. Initial timing instrumentation measured
  a 15.1µs outlier; warm both the algorithm and measurement path before collecting
  final samples. Failure logs remain intact; no threshold was relaxed.
- Fetch integration initially mocked Date.now after it had been captured by the
  adapter. QoS completion timing now uses the monotonic performance clock,
  retaining legacy forwarded time-to-headers latency. Focused retry 16/16 PASS.
- Preview launch with a server-token environment assignment was rejected by
  automatic approval review. Launch without credential changes succeeded.

Next step: wait for human direction. Push, remote multi-platform CI and npm
publication remain outside this mission.
