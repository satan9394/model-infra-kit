# scripts/e2e — one command, every acceptance scenario

```bash
cd <repo root>
node scripts/e2e/run.mjs
```

Exit code **0** means every check passed; any failure prints a `FAIL` line, keeps
going so the whole list is visible, and exits non-zero. Nothing here touches the
public internet: the provider is a local mock HTTP server and the price
catalogue is pinned to an unreachable URL on purpose.

## What it proves

| Check | Scenario (`docs/SPEC.md` §6, `tasks/T09-examples-e2e.md`) |
|---|---|
| AC1 | Fresh temp dir + temp db → `mik init` → `mik serve` boots with **zero providers**; the port is released again on shutdown |
| AC2 | Mock provider: `mik provider add` → connection test ok → model list non-empty → default model set |
| PRICE | `mik pricing set` installs a manual price (P1 = $1/M in, $2/M out) |
| EX1 | `examples/cli-agent` run as its own process: init → add → test → models → default → generate / stream / tool call → usage summary |
| AC3 | The proxy endpoint (`POST /v1/chat/completions`) answers generate / stream / tool call; all three are metered |
| AC4 | `examples/openai-sdk` — untouched SDK code, metered as `source=fetch` |
| AC5 | `examples/python-host` — cross-language call metered |
| AC6 | Price catalogue pointed at an unreachable URL → `pricing` state `stale`, `deepseek-chat` still quotes from the bundled archive |
| AC7 | Manual price change: the historical row keeps its cost, a new request is billed at P2 |
| DASH | **SPEC §6 ③** — the dashboard (`next start`, port 3210) renders the rows this run wrote: the overview shows the real cost / request count / token total and the `pricing stale` source badge, `/logs` shows a recorded request id at its real cost, `/pricing` shows the manual rates (`$3.00` / `$15.00`). The money cell is asserted on its own `data-testid="overview-cost-span"` against a **recorded spread** (`low 0.01 < usd 0.012345 < high 0.02`, written through `hub.usage.record`): every other row is point-priced, so without that row "the cell prints the band" and "the cell prints the deprecated `costUsd` point estimate" render the same string (EVO-G90). Then the same pages are re-rendered with an unreachable `mik serve`: the numbers must disappear — the anchored cell reads `—` — and an explanatory banner must appear, which is what proves the HTML is live data, not markup |
| DIST | The **published artifact** (`packages/mik/dist/cli.mjs`, built on demand if absent) runs `--help`, then `serve` on 3212 and answers `/api/health` with the recorded provider/model/pricing state |
| AC8 | `--inject-failure` → the runner exits non-zero and names the failing check |

Two flags exist for proving the checks themselves:

```bash
node scripts/e2e/run.mjs --inject-failure    # fail AC1 → exit 1
node scripts/e2e/run.mjs --break-dashboard   # point the dashboard at a dead
                                             # `mik serve` → DASH must FAIL
```

## Files

| File | Purpose |
|---|---|
| `run.mjs` | The runner. Re-executes itself with `--experimental-transform-types` so `node scripts/e2e/run.mjs` needs no flags. |
| `mock-provider.mjs` | A local OpenAI-compatible provider: `GET /v1/models`, chat completions, SSE streaming, tool calls. Deterministic token counts (1200 in / 800 cached / 300 out / 64 reasoning), no network. |
| `loader.mjs` | Maps `model-infra-kit`, `model-infra-kit/server` and `model-infra-kit/cli` onto `packages/mik/src`, and rewrites a missing relative `./x.js` to `./x.ts`. That is what lets the examples run against the sources with no build step. |

The dashboard check reuses `apps/dashboard/lib/format.ts` directly, so the
strings it asserts (`$0.0243`, `23.6K`, `$3.00`) are produced by the same helpers
the pages render with — the expected value cannot drift from the page.

## Key numbers it prints

The run ends with the usage rows, tokens, cost, cache-hit rate and the
per-scenario numbers (request ids, per-call costs, the stale quote, the P1/P2
costs). The temporary directory (`.tmp/e2e-<timestamp>/`) is kept: it holds the
SQLite database and `mik.config.json` that produced the numbers.

## Two deliberate deviations

1. **`mik provider test` and `mik models --refresh` are not invoked.**
   Both refuse to run when `--offline` is set (their own guard), and the suite is
   offline by design. AC2 therefore drives the same hub code paths
   (`hub.ai.test()` / `hub.models.refresh()`) directly; the CLI surface itself is
   still covered by `init`, `provider add`, `provider list`, `models`, `pricing`
   and `serve`.
2. **Port 3211 is preferred but not assumed.** If something else already listens
   there, the run picks a free ephemeral port and says so in its header. The same
   applies to 3210 (dashboard) and 3212 (dist serve).
3. **DASH starts `next start` directly instead of `mik dashboard`.** The CLI
   spawns Next with `stdio: "inherit"`; on Windows killing the CLI leaves the
   Next server orphaned on the port, which would break the "port released"
   assertion. DASH therefore spawns the same binary (`apps/dashboard/node_modules/next`)
   itself, so it owns the process it stops. `mik dashboard`'s own argument
   handling stays covered by `--help` in DIST.

## Known limitation found while writing the Python example

`POST /v1/chat/completions` with a `{"role":"system"}` entry inside `messages`
fails with HTTP 500: the proxy forwards `messages` straight into the AI SDK,
which rejects system messages in `messages` (they belong in the `system` field).
`examples/python-host/host.py` therefore sends a single user message.
