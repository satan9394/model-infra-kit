# LangChain Python

This example uses LangChain's `ChatOpenAI` against the local OpenAI-compatible
endpoint. It needs Python 3.9+ and does not require an MIK-specific LangChain
plugin.

```bash
python -m pip install -r requirements.txt
MIK_BASE_URL=http://127.0.0.1:3211/v1 MIK_MODEL=provider:model python agent.py
```

On Windows PowerShell:

```powershell
$env:MIK_BASE_URL = "http://127.0.0.1:3211/v1"
$env:MIK_MODEL = "provider:model"
python .\agent.py
```

The standard OpenAI-compatible `base_url` routes the call through `mik serve`.
`X-Mik-Session-Id` and `X-Mik-Trace-Id` attach the request to a Session and
Trace; the server consumes these headers and stores only their identifiers.
Set `MIK_SERVER_TOKEN` when the MIK server requires bearer authentication.
The script prints the trace id for lookup in the Agent task dashboard.
