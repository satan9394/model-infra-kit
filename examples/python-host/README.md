# examples/python-host — a Python project that only changes its base URL

`docs/SPEC.md` §2.3: the local service + OpenAI-compatible endpoint surface.
`host.py` uses nothing but the standard library, so any Python 3.8+ works.

```bash
python host.py http://127.0.0.1:3211/v1 local:mock-mini
# or: MIK_BASE_URL=... MIK_MODEL=... python host.py
```

| Argument / env | Default | Meaning |
|---|---|---|
| `argv[1]` / `MIK_BASE_URL` | `http://127.0.0.1:3211/v1` | proxy base URL |
| `argv[2]` / `MIK_MODEL` | — (required) | `provider:model` to call |

The script POSTs to `<base_url>/chat/completions`, prints the answer and the
`usage` block, and exits non-zero if the proxy returned no usage. It sends
`"user": "python-host"`, which the proxy stores as the usage event's
`session_id`, so the run can be attributed afterwards:

```bash
mik usage logs --config mik.config.json | grep python-host
```

Notes:

- The request carries **one user message**: the proxy maps `messages` onto the AI
  SDK, which rejects a `system` role inside `messages` (HTTP 500). A system
  prompt would need the `system` field, which the OpenAI-compatible endpoint does
  not currently expose.
- Proxies are disabled for the call (`ProxyHandler({})`), so a local endpoint is
  never routed through `HTTP_PROXY`.

`scripts/e2e/run.mjs` runs this file as its `AC5` check, using
`D:\Technology_application\Anconda_All\Anaconda3\envs\claude\python.exe` (override
with `MIK_E2E_PYTHON`).
