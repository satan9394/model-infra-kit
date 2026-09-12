# EVO-G72b test-harness helper: kill the node services a stubbed battery.ps1 run leaked.
#
# Why a helper process instead of inline PowerShell in the test:
#   The stub `node` is a `.cmd` shim, so `Start-Process -PassThru` records the cmd
#   wrapper's pid and battery.ps1's own `finally` cannot reach the real node
#   grandchild. The test therefore has to reap them itself. Doing that by asking a
#   helper (rather than by spelling a match pattern into a shell command line)
#   keeps the port/path literals out of the command text the harness runner
#   embeds into its own CommandLine — the failure mode an Evaluator hit when a
#   kill command matched its own runner.
#
# Usage: pwsh -NoProfile -File reap-leaked-servers.ps1 -Config <test pid> -Token <db path> -Port <mock port>
#   The stub `node` is a `.cmd` shim, so `Start-Process -PassThru` records the cmd
#   wrapper's pid and battery.ps1's own `finally` cannot reach the real node
#   grandchild; the test has to reap them itself.
#   Two selectors, because the two services carry different evidence:
#     -Token <db path>  → `cli.mjs serve --db <path>` (and the battery's `MIK_DB`,
#                          though that only lands in an env, never in CommandLine)
#     -Port  <mock port> → `mock-openai.mjs --port <port>` (the mock is never
#                          handed the db, so a db-only match leaked it — measured)
#   Literals live here, not in a shell command line, so a harness runner that
#   embeds the command it runs into its own CommandLine cannot be matched by them.
#
# Safety guards before anything is killed:
#   1. a `name`/`executablepath` prefilter for node processes (never a substring in `$cmd`);
#   2. the command line must contain the selector (unique db path or unique port);
#   3. the command line must also look like one of this harness's two services;
#   4. never the helper's own process, its parent, or the configured test process;
#   5. a second identical check immediately before each Stop-Process.
# Exit code = number of processes still matching afterwards (0 = clean).
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][int]$Port
)

$ErrorActionPreference = "Stop"
$self = $PID
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$self").ParentProcessId
# Measured shape: `…node.exe"  apps\dashboard\scripts\mock-openai.mjs --port 62562`
# (password-style: a space before the port), so "…mjs <port>" never matches.
# Match the flag+value as a substring instead of guessing the separator.
$portFlag = "--port $Port"

# NOTE (R219): the parameter is `$processId`, never `$pid` — `$PID` is a read-only
# automatic variable, and assigning to it fails *silently*: the helper then killed
# nothing and still reported `remaining=0`. This was measured, not guessed.
function Test-IsLeaked([string]$cmd, [int]$processId) {
  if (-not $cmd) { return $false }
  if ($processId -eq $self -or $processId -eq $parent) { return $false }
  if ($Config -ne "" -and $processId -eq [int]$Config) { return $false }
  $isService = $cmd.Contains("mock-openai.mjs") -or $cmd.Contains("cli.mjs serve")
  if (-not $isService) { return $false }
  return ($cmd.Contains($Token) -or $cmd.Contains($portFlag))
}

function Get-Leaked {
  Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { Test-IsLeaked $_.CommandLine $_.ProcessId }
}

$targets = @(Get-Leaked)
$killed = @()
foreach ($p in $targets) {
  # Re-read immediately before killing: only a still-matching process is stopped.
  $again = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)" -ErrorAction SilentlyContinue
  if (-not $again) { continue }
  # Same predicate as the scan: a process is only stopped while it still matches.
  if (-not (Test-IsLeaked $again.CommandLine $again.ProcessId)) { continue }
  $parentName = (Get-CimInstance Win32_Process -Filter "ProcessId=$($again.ParentProcessId)" -ErrorAction SilentlyContinue).Name
  Stop-Process -Id $again.ProcessId -Force -ErrorAction SilentlyContinue
  $killed += "{0} ({1} <- parent {2} {3})" -f $again.ProcessId, $again.Name, $again.ParentProcessId, $parentName
}
Start-Sleep -Milliseconds 700
$left = @(Get-Leaked)
Write-Output "reap: token=$Token port=$Port killed=$($killed.Count) remaining=$($left.Count)"
foreach ($k in $killed) { Write-Output "  killed $k" }
foreach ($l in $left) { Write-Output "  LEAK $($l.ProcessId) $($l.CommandLine)" }
exit $left.Count
