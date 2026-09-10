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
$env:K = "sk-envcheck"
$env:NO_PROXY = "127.0.0.1,localhost"

function Fail([string]$Message) {
  Write-Output "FAIL[$Name] $Message"
  exit 1
}

Write-Output "== [$Name] bin: direct =="
$v = node packages/mik/dist/cli.mjs --version
if ("$v" -notmatch "mik 0\.1") { Fail "direct --version: $v" }

Write-Output "== [$Name] mock + serve + curl =="
$mock = Start-Process node -ArgumentList "apps\dashboard\scripts\mock-openai.mjs","--port",$MockPort -PassThru -WindowStyle Hidden
# Wait until the mock answers /v1/models before configuring anything on it.
for ($i = 0; $i -lt 15; $i++) {
  $m = curl.exe -s -m 2 "http://127.0.0.1:$MockPort/v1/models"
  if ($m -match "mock") { break }
  Start-Sleep -Seconds 1
}
node packages/mik/dist/cli.mjs provider add local --base-url "http://127.0.0.1:$MockPort/v1" --api-key-ref env:K | Out-Null
$srv = Start-Process node -ArgumentList "packages/mik/dist/cli.mjs","serve","--port",$ServePort,"--db",$Db,"--app-id","envcheck" -PassThru -WindowStyle Hidden

try {
  # Poll health (the mock/serve pair can take a moment on a busy machine).
  $h = ""
  for ($i = 0; $i -lt 15; $i++) {
    $h = curl.exe -s -m 2 "http://127.0.0.1:$ServePort/api/health"
    if ($h -match '"status":"ok"') { break }
    Start-Sleep -Seconds 1
  }
  if ("$h" -notmatch '"status":"ok"') { Fail "health: $h" }
  Write-Output "  health ok"

  Set-Content -Encoding utf8 "$env:TEMP\chat-$Name.json" '{"model":"local:mock-mini","messages":[{"role":"user","content":"hi"}]}'
  $p = ""
  for ($i = 0; $i -lt 5; $i++) {
    $p = curl.exe -s -m 3 -X POST "http://127.0.0.1:$ServePort/v1/chat/completions" -H "content-type: application/json" --data-binary "@$env:TEMP\chat-$Name.json"
    if ($p -match '"usage"') { break }
    Start-Sleep -Seconds 1
  }
  if ($p -notmatch '"usage"') { Fail "chat: $p" }
  Write-Output "  chat ok"

  $s = node packages/mik/dist/cli.mjs usage summary
  if ("$s" -notmatch "Requests") { Fail "summary" }
  Write-Output "  summary ok"

  node packages/mik/dist/cli.mjs usage export --format csv --out "$env:TEMP\usage-$Name.csv" | Out-Null
  $head = Get-Content "$env:TEMP\usage-$Name.csv" -TotalCount 1
  if ($head -notmatch "^ts,app_id") { Fail "csv header: $head" }
  Write-Output "  csv ok"

  $py = python examples/python-host/host.py "http://127.0.0.1:$ServePort/v1" local:mock-mini
  if ("$py" -notmatch "status:  200") { Fail "python host: $py" }
  Write-Output "  python ok"

  Write-Output "ENV_OK $Name"
}
finally {
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
}