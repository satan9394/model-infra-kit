# examples/openai-sdk — existing SDK code, metered

`docs/SPEC.md` §2.2: the `fetch` adapter surface. The business code in
`index.ts` is ordinary OpenAI SDK code. Exactly two options changed:

```ts
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "managed-by-model-infra-kit",
  baseURL: mik.baseUrl,
  fetch: mik.fetch,
})

// ── untouched ──
const completion = await client.chat.completions.create({ model, messages })
```

`mik.fetch` forwards the request to the provider named by `provider:model` in the
body, attaches the configured credential (a caller-supplied one is never
forwarded), reads the provider's `usage` from a clone of the response, prices it
and stores it. The caller receives the provider's response unchanged.

## Run it

```bash
pnpm --filter @mik/example-openai-sdk start -- \
  --base-url http://127.0.0.1:3211/v1 --model local:mock-mini
```

| Flag / env | Default | Meaning |
|---|---|---|
| `--model` / `MIK_EXAMPLE_MODEL` | configured default | `provider:model` to call |
| `--base-url` / `MIK_EXAMPLE_BASE_URL` | none | register this endpoint if the provider does not exist yet |
| `--provider` / `MIK_EXAMPLE_PROVIDER` | `local` | provider id used by `--base-url` |
| `--db` / `MIK_DB` | `example-openai-sdk.db` | SQLite database |
| `--app-id` / `MIK_APP_ID` | `example-openai-sdk` | owner stamped on usage rows |
| `--online-pricing` | off | let the price catalogue load from the network |
| `MIK_CACHE_DIR` | library default | price-catalogue cache directory |

The script prints the answer, then the metering proof: the rows with
`source=fetch`, their tokens and cost, and `usage.summary()`. It exits non-zero
if the call was not metered.

`scripts/e2e/run.mjs` runs this file as its `AC4` check.
