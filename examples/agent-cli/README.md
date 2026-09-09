# examples/agent-cli — a minimal Agent CLI on top of mik

A runnable skeleton of the shape a host CLI (Claude Code 类) needs: a thin
command layer that owns the UI, with `model-infra-kit` owning the model layer.

```
agent-cli model add <id> --preset <p> [--base-url <url>] [--api-key-ref <ref>]
agent-cli model list
agent-cli model use <provider:model>
agent-cli chat "<prompt>" [--model <provider:model>] [--session <id>]
agent-cli stats
```

| File | What it is |
|---|---|
| `index.ts` | the CLI itself (`model` / `chat` / `stats`), public API only |
| `quickstart.ts` | the smallest complete host: init → generate → stream + tool → close |
| `mock-provider.mjs` | offline OpenAI-compatible mock with real `tool_calls` streaming |
| `pitfalls.ts` | four traps from the guide, each asserted against the real library |
| `peer-missing.mjs` | reproduces "`@ai-sdk/*` not installed" in a scratch `npm i` |
| `package.json` | the dependency set a host needs (`ai` + `model-infra-kit`) |

## 1. Run it offline (no key, no network)

The runs below need **two terminals**. The mock binds `127.0.0.1:3221` only; it
never makes an outbound request, and the price archive bundled with
`llm-pricing` prices every call while offline.

```bash
# terminal 1 — the mock provider (repo root)
node examples/agent-cli/mock-provider.mjs --port 3221

# terminal 2 — the CLI (repo root; runs TypeScript directly, no build)
DB="$TEMP/agent-cli-demo.db"          # Windows PowerShell: $db = "$env:TEMP\agent-cli-demo.db"
RUN="node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./scripts/e2e/loader.mjs examples/agent-cli/index.ts"

$RUN model add local --preset custom-openai-compatible --base-url http://127.0.0.1:3221/v1 --db "$DB"
$RUN model add gateway --preset openrouter --api-key-ref env:OPENROUTER_API_KEY --db "$DB"
$RUN model use local:deepseek-chat --db "$DB"
$RUN model list --db "$DB"
$RUN chat "what time is it right now?" --db "$DB"      # → one tool call, then an answer
$RUN chat "say hello in one short sentence" --db "$DB" # → no tool call
$RUN stats --db "$DB"                                  # → rows + cost
```

`scripts/e2e/loader.mjs` maps the published specifiers (`model-infra-kit`,
`model-infra-kit/cli`) onto `packages/mik/src`, so the examples always exercise
the current sources. With the package built (`pnpm --filter model-infra-kit
build`) the same files run against `dist` with plain `node index.ts`.

Inside the pnpm workspace you can also use the package script (needs `pnpm
install` so the workspace link exists):

```bash
pnpm --filter @mik/example-agent-cli start -- model list
```

## 2. Run it against a real provider

```bash
# DeepSeek: preset fills protocol + base URL; the key stays in the environment
export DEEPSEEK_API_KEY=sk-...
$RUN model add deepseek --preset deepseek --api-key-ref env:DEEPSEEK_API_KEY --db "$DB"
$RUN model use deepseek:deepseek-chat --db "$DB"
$RUN chat "解释一下这个仓库的模型层做了什么" --db "$DB"
$RUN stats --db "$DB"
```

```bash
# Any OpenAI-compatible gateway (Qwen / GLM / Kimi / a relay):
#   npm i @ai-sdk/openai-compatible      # the peer package for that protocol
$RUN model add relay --preset custom-openai-compatible --base-url https://your-gateway/v1 \
  --api-key-ref env:RELAY_API_KEY --db "$DB"
```

Key handling: `--api-key-ref` accepts `env:VAR`, `file:path` or
`keychain:service` and **refuses a plaintext key**. The provider row stores the
reference; the secret is resolved at call time.

## 3. What each command maps to

| Command | mik API |
|---|---|
| `model add` | `mik.providers.add({ id, presetId, baseUrl, apiKeyRef })` |
| `model list` | `mik.providers.list()`, `mik.providers.defaultModel()`, `mik.models.list()` |
| `model use` | `mik.providers.setDefaultModel("provider:model")` |
| `chat` | `mik.stream({ messages, tools, sessionId, tags })` |
| `stats` | `mik.usage.summary()`, `mik.usage.query({ limit })` |
| every command | `ModelInfra.init({ appId, db, onWarn })` … `await mik.close()` |

## 4. Notes

- **Offline by default.** `pricingFetch` is a function that throws, so nothing
  fetches the catalogue; `syncCatalog: false` keeps providers from being probed.
  Add `--online-pricing` (or drop both options) for a real host.
- **Every call is metered**, successes and failures alike, into the SQLite file
  named by `--db`. `stats` shows the row count and the cost from the events.
- **Tool loop lives in mik.** `get_time` runs in-process (system clock); the
  mock streams `tool_calls` the way a real OpenAI-compatible provider does, so
  `chat` exercises the full `tool_call_complete` → execute → second step path.
- The full design discussion — architecture, subcommand set, six installation
  routes, release checklist — is in
  [`docs/agent-cli-guide.md`](../../docs/agent-cli-guide.md).
