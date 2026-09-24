#!/usr/bin/env python
"""A LangChain OpenAI-compatible client metered by `mik serve`."""

from __future__ import annotations

import os
import uuid

from langchain_openai import ChatOpenAI

base_url = os.environ.get("MIK_BASE_URL", "http://127.0.0.1:3211/v1")
model = os.environ.get("MIK_MODEL", "provider:model")
session_id = os.environ.get("MIK_SESSION_ID", f"langchain-{uuid.uuid4().hex[:12]}")
trace_id = uuid.uuid4().hex

# Three-line integration: point the standard OpenAI-compatible client at MIK,
# pass ordinary session/trace headers, and invoke the existing chain.
llm = ChatOpenAI(
    model=model,
    base_url=base_url,
    api_key=os.environ.get("MIK_SERVER_TOKEN", "local"),
    default_headers={"X-Mik-Session-Id": session_id, "X-Mik-Trace-Id": trace_id},
)
response = llm.invoke("Reply with one short sentence about LangChain.")

print(f"session: {session_id}")
print(f"trace:   {trace_id}")
print(f"answer:  {response.content}")
print(f"usage:   {response.usage_metadata}")
