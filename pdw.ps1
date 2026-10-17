$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot '.agents\skills\personal-dev-workflow\scripts\pdw.mjs') @args
exit $LASTEXITCODE
