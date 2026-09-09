#!/usr/bin/env python
"""Example host: a Python project that only changes its `base_url`.

`docs/SPEC.md` §2.3 — the local service + OpenAI-compatible endpoint surface.
The script talks plain HTTP to `http://127.0.0.1:3211/v1/chat/completions` with
nothing but the standard library, so it works on any machine with Python 3.8+
and no third-party packages.

    python host.py [base_url] [model]

`base_url` defaults to `http://127.0.0.1:3211/v1`, `model` to the environment
variable `MIK_MODEL` (or the `provider:model` passed as the second argument).
Every request carries `"user": "python-host"`, which the proxy stores as the
usage event's `session_id`, so the run can be attributed afterwards.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

SESSION = "python-host"


def main(argv: list[str]) -> int:
    base_url = (argv[1] if len(argv) > 1 else os.environ.get("MIK_BASE_URL", "http://127.0.0.1:3211/v1")).rstrip("/")
    model = argv[2] if len(argv) > 2 else os.environ.get("MIK_MODEL", "")
    if not model:
        print("usage: host.py [base_url] [model]", file=sys.stderr)
        return 2

    payload = {
        "model": model,
        # One user message only: the proxy maps `messages` onto the AI SDK,
        # which rejects a "system" role inside `messages`.
        "messages": [{"role": "user", "content": "Reply with one short sentence about Python."}],
        "user": SESSION,
    }
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )

    # A local endpoint must never be sent through an HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
            status = response.status
    except urllib.error.HTTPError as error:
        print(f"HTTP {error.code}: {error.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - the example reports whatever went wrong
        print(f"request failed: {error}", file=sys.stderr)
        return 1

    message = (body.get("choices") or [{}])[0].get("message", {})
    print(f"status:  {status}")
    print(f"model:   {body.get('model')}")
    print(f"answer:  {json.dumps((message.get('content') or '')[:120])}")
    print(f"usage:   {json.dumps(body.get('usage'))}")
    print(f"session: {SESSION}")
    if not body.get("usage"):
        print("FAIL: the proxy returned no usage", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
