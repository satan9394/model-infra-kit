# Environment battery for model-infra-kit on Windows PowerShell.
# Usage: pwsh -File battery.ps1 <name> <repo-root> <serve-port> <mock-port> <db>
param(
  [string]$Name = "powershell",
  [string]$Root,
  [int]$ServePort = 3231,
  [int]$MockPort = 3212,
  [string]$Db
)

Set-Location $Root
$env:MIK_DB = $Db
$env:MIK_APP_ID = "envcheck"
# The battery asserts English CLI wording (`usage summary` must contain
# "Requests"): a tool is not a user and must not follow the machine's locale, or
# the whole check goes red on a zh-CN host and green in CI (G12/G13).
$env:MIK_LANG = "en"
$env:K = "sk-envcheck"
# G01: without a token the serve's write endpoints 401, so the battery gives
# the serve a token and every write below carries it.
$env:MIK_SERVER_TOKEN = "envcheck-token"
$env:NO_PROXY = "127.0.0.1,localhost"

# EVO-G72b: the two failure modes must be named separately, exactly like
# battery.sh does with PIPESTATUS. `Fail` therefore gets one shared wording for
# "the command itself exited non-zero" (`CliFailed`, always reporting the exit
# code — PowerShell leaves $LASTEXITCODE unset when a call never ran) and keeps
# the per-step wording for "the command ran but its output lacks what we assert."
#
# Pipe caveat (measured, pwsh 7.6.6): `node … | Select-String`/`Out-Null` leaves
# $LASTEXITCODE at the native command's code ($? turns False, the code survives).
# The steps below still read $LASTEXITCODE in the statement *right after* the
# call so no later command can overwrite it.
function Fail([string]$Step, [string]$Message = "") {
  Write-Output "STEP $Step fail"
  Write-Output "FAIL[$Name] $Step $Message"
  exit 1
}
function CliFailed([string]$Step) {
  $code = $LASTEXITCODE
  $shown = if ($null -eq $code -or "$code" -eq "") { "(unset)" } else { "$code" }
  Fail $Step "cli exit non-zero (exit code $shown)"
}
function Pass([string]$Step) { Write-Output "STEP $Step ok" }

Write-Output "== [$Name] bin: direct =="
# Compare against the package version instead of a pinned string: bumping the
# version must never turn the battery red (and this proves build == manifest).
$wantVersion = (Get-Content "packages\mik\package.json" -Raw | ConvertFrom-Json).version
if (-not $wantVersion) { Fail "bin-direct" "could not read the package version" }
$v = node packages/mik/dist/cli.mjs --version
if ($LASTEXITCODE -ne 0) { CliFailed "bin-direct" }
if ("$v" -match [regex]::Escape("mik $wantVersion")) { Pass "bin-direct" } else { Fail "bin-direct" "version line lacks 'mik $wantVersion' (output: $v)" }

Write-Output "== [$Name] mock + serve + curl =="
$mock = Start-Process node -ArgumentList "apps\dashboard\scripts\mock-openai.mjs","--port",$MockPort -PassThru -WindowStyle Hidden
# Wait until the mock answers /v1/models before configuring anything on it.
for ($i = 0; $i -lt 15; $i++) {
  $m = curl.exe -s -m 2 "http://127.0.0.1:$MockPort/v1/models"
  if ($m -match "mock") { break }
  Start-Sleep -Seconds 1
}
node packages/mik/dist/cli.mjs provider add local --base-url "http://127.0.0.1:$MockPort/v1" --api-key-ref env:K | Out-Null
# battery.sh gates this step; a non-zero here is the difference between "the mock
# never got configured" (diagnosed now, as in bash) and a downstream chat/health
# timeout that hides the cause.
if ($LASTEXITCODE -ne 0) { CliFailed "provider-add" }
$srv = Start-Process node -ArgumentList "packages/mik/dist/cli.mjs","serve","--port",$ServePort,"--db",$Db,"--app-id","envcheck" -PassThru -WindowStyle Hidden

try {
  # Poll health (the mock/serve pair can take a moment on a busy machine).
  $h = ""
  for ($i = 0; $i -lt 15; $i++) {
    $h = curl.exe -s -m 2 "http://127.0.0.1:$ServePort/api/health"
    if ($h -match '"status":"ok"') { break }
    Start-Sleep -Seconds 1
  }
  if ($h -match '"status":"ok"') { Pass "health" } else { Fail "health" $h }

  Set-Content -Encoding utf8 "$env:TEMP\chat-$Name.json" '{"model":"local:mock-mini","messages":[{"role":"user","content":"hi"}]}'
  $p = ""
  for ($i = 0; $i -lt 5; $i++) {
    $p = curl.exe -s -m 3 -X POST "http://127.0.0.1:$ServePort/v1/chat/completions" -H "content-type: application/json" -H "authorization: Bearer envcheck-token" --data-binary "@$env:TEMP\chat-$Name.json"
    if ($p -match '"usage"') { break }
    Start-Sleep -Seconds 1
  }
  if ($p -match '"usage"') { Pass "chat" } else { Fail "chat" $p }

  # EVO-G72b aligns this step with battery.sh's PIPESTATUS split (G72): the CLI's
  # own exit code is reported as one thing, a missing "Requests" line as another.
  # The command line itself is deliberately unchanged — there is no pipe on this
  # step in PowerShell, so nothing was moved out of the way to make this work
  # (R182: a diagnostic fix must not relocate a detection point).
  $s = node packages/mik/dist/cli.mjs usage summary
  if ($LASTEXITCODE -ne 0) { CliFailed "summary" }
  if ("$s" -match "Requests") { Pass "summary" } else { Fail "summary" "no Requests line" }

  $csvOut = "$env:TEMP\usage-$Name.csv"
  node packages/mik/dist/cli.mjs usage export --format csv --out $csvOut | Out-Null
  if ($LASTEXITCODE -ne 0) { CliFailed "csv" }
  $head = Get-Content $csvOut -TotalCount 1
  if ("$head" -match "^ts,app_id") { Pass "csv" } else { Fail "csv" "header: $head" }

  # EVO-G72b review follow-up: the python host had the same gap as the CLI steps —
  # no exit-code check, and a bare `$py` produced an empty reason. Same split.
  $py = python examples/python-host/host.py "http://127.0.0.1:$ServePort/v1" local:mock-mini
  if ($LASTEXITCODE -ne 0) { CliFailed "python" }
  if ("$py" -match "status:  200") { Pass "python" } else { Fail "python" "no 'status:  200' line (output: $py)" }

  Write-Output "ENV_OK $Name"
}
finally {
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
}