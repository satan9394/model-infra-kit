# examples/cli-agent — the embedded-library host

A self-built CLI agent that embeds the library (`docs/SPEC.md` §2.1). One run
walks the whole acceptance scenario through the public API:

```
ModelInfra.init() → providers.add() → ai.test() → models.refresh() →
providers.setDefaultModel() → generate() → stream() → generate(tools) →
usage.summary()
```

## Run it

```bash
# against any OpenAI-compatible endpoint, e.g. the repo's mock provider
pnpm --filter @mik/example-cli-agent start -- --base-url http://127.0.0.1:3211/v1
```

| Flag / env | Default | Meaning |
|---|---|---|
| `--base-url` / `MIK_EXAMPLE_BASE_URL` | `http://127.0.0.1:3211/v1` | endpoint to register |
| `--provider` / `MIK_EXAMPLE_PROVIDER` | `local` | provider id to create |
| `--model` / `MIK_EXAMPLE_MODEL` | first discovered | default model |
| `--db` / `MIK_DB` | `example-cli-agent.db` | SQLite database |
| `--app-id` / `MIK_APP_ID` | `example-cli-agent` | owner stamped on usage rows |
| `--api-key-ref` / `MIK_EXAMPLE_API_KEY_REF` | none | `env:VAR`, `file:path` or `keychain:service` — never a plaintext key |
| `--online-pricing` | off | let the price catalogue load from the network |
| `MIK_CACHE_DIR` | library default | price-catalogue cache directory |

## Notes

- **Secrets are references.** `apiKeyRef` is stored as `env:…` / `file:…`; the
  provider record never holds the key. A keyless local endpoint is supported.
- **Offline by default.** The example injects a failing `pricingFetch`, so the
  bundled price archive answers and the run never depends on the network.
- **Every call is metered**, including failures, and the final block prints the
  usage summary plus the per-source counts (`generate=2 stream=1` for one
  generate, one stream and one tool-calling generate).
- `pnpm --filter @mik/example-cli-agent start` runs the TypeScript source through
  `scripts/e2e/loader.mjs` (no build required). After `pnpm build`, `npm start`
  style invocation works against the published entry point too.

`scripts/e2e/run.mjs` runs this exact file as its `EX1` check.
