#!/usr/bin/env bash
# Environment battery for model-infra-kit: exercises the CLI bin entry (target +
# the npm symlink regression), `mik serve`, the OpenAI-compatible endpoint, usage
# recording, and the python host, all offline against a local mock.
#
# Usage: battery.sh <name> <repo-root> <serve-port> <mock-port> <db> <link-target> [symlink-mode]
#   link-target: absolute path to dist/cli.mjs in THIS shell's native convention
#                (Windows Git Bash: E:/... ; WSL: /mnt/e/...)
#   symlink-mode: native (default) | skip
#     native — full npm-Unix-bin regression: exec dist/cli.mjs through a symlink.
#     skip   — Git Bash / Windows node: symlink entry breaks ESM relative imports
#              (node resolves them against the link's dir, not the real file),
#              which is exactly why Windows npm ships .cmd shims instead; the
#              Windows shim path is covered by the PowerShell/npx checks.
set -euo pipefail

NAME=$1
ROOT=$2
SERVEPORT=$3
MOCKPORT=$4
DB=$5
LINKTARGET=$6
SYMLINK_MODE=${7:-native}

cd "$ROOT"
export MIK_DB="$DB"
export MIK_APP_ID="envcheck"
export K="sk-envcheck"
export NO_PROXY="127.0.0.1,localhost"
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY 2>/dev/null || true
PY=$(command -v python3 || command -v python || true)

fail() { echo "STEP $1 fail"; echo "FAIL[$NAME] $1"; echo "$2" 2>/dev/null || true; exit 1; }
pass() { echo "STEP $1 ok"; }

echo "== [$NAME] bin: direct =="
node packages/mik/dist/cli.mjs --version | grep -q "mik 0.1" && pass "bin-direct" || fail "bin-direct"
echo "== [$NAME] bin: via symlink (Linux/macOS npm bin regression) =="
if [ "$SYMLINK_MODE" = "skip" ]; then
  echo "  skipped: Windows node does not resolve ESM relative imports through a symlink entry (npm uses .cmd shims there); covered by npx/PowerShell checks."
else
  mkdir -p "$ROOT/.tmp"
  LINK="$ROOT/.tmp/mik-bin-$NAME"
  chmod +x "packages/mik/dist/cli.mjs" 2>/dev/null || true
  # A real symlink reproduces npm's Unix bin exactly; if the platform cannot make
  # one (Windows Git Bash without privileges), a copy still exercises the shebang.
  ln -sf "$LINKTARGET" "$LINK" 2>/dev/null || cp -f "$LINKTARGET" "$LINK"
  "$LINK" --version | grep -q "mik 0.1" && pass "bin-symlink" || fail "bin-symlink"
fi
echo "== [$NAME] mock + serve + curl =="
node apps/dashboard/scripts/mock-openai.mjs --port "$MOCKPORT" >/tmp/mik-mock-$NAME.log 2>&1 &
MOCK=$!
# Wait until the mock answers /v1/models before configuring anything on it.
# `if … then break` keeps set -e from killing the battery when the first probe
# fails (the mock is still starting).
for _ in $(seq 1 15); do
  if curl -s -m 2 "http://127.0.0.1:$MOCKPORT/v1/models" 2>/dev/null | grep -q "mock"; then break; fi
  sleep 1
done
rm -f "$DB" 2>/dev/null || true
node packages/mik/dist/cli.mjs provider add local --base-url "http://127.0.0.1:$MOCKPORT/v1" --api-key-ref env:K >/dev/null 2>&1 || fail "provider-add"
node packages/mik/dist/cli.mjs serve --port "$SERVEPORT" --db "$DB" --app-id envcheck >/tmp/mik-serve-$NAME.log 2>&1 &
SRV=$!
trap 'kill $SRV $MOCK 2>/dev/null || true' EXIT
# Poll health (the mock/serve pair can take a moment on a busy machine).
HEALTH=""
for _ in $(seq 1 15); do
  HEALTH=$(curl -s -m 2 "http://127.0.0.1:$SERVEPORT/api/health" 2>/dev/null || true)
  if [ -n "$HEALTH" ]; then break; fi
  sleep 1
done
echo "$HEALTH" | grep -q '"status":"ok"' && pass "health" || fail "health" "$HEALTH"
# Payload path: Windows Git Bash uses Windows curl.exe, which cannot read an
# msys /tmp/... path — use a native path when cygpath exists.
PAY="$ROOT/.tmp/chat-$NAME.json"
if command -v cygpath >/dev/null 2>&1; then PAY=$(cygpath -w "$PAY"); fi
printf '{"model":"local:mock-mini","messages":[{"role":"user","content":"hi"}]}' >"$ROOT/.tmp/chat-$NAME.json"
for _ in $(seq 1 5); do
  BODY=$(curl -s -m 3 -X POST "http://127.0.0.1:$SERVEPORT/v1/chat/completions" \
    -H "content-type: application/json" --data-binary "@$PAY" 2>/dev/null || true)
  if printf '%s' "$BODY" | grep -q '"usage"'; then break; fi
  sleep 1
done
printf '%s' "$BODY" | grep -q '"usage"' && pass "chat" || fail "chat" "$BODY"
node packages/mik/dist/cli.mjs usage summary | grep -q "Requests" && pass "summary" || fail "summary"
CSV="$ROOT/.tmp/usage-$NAME.csv"
if command -v cygpath >/dev/null 2>&1; then CSV=$(cygpath -w "$CSV"); fi
node packages/mik/dist/cli.mjs usage export --format csv --out "$CSV" >/dev/null 2>&1 || { echo "STEP csv fail"; echo "FAIL[$NAME] csv export"; exit 1; }
head -1 "$CSV" | grep -q "^ts,app_id" && pass "csv" || fail "csv" "header: $(head -1 "$CSV" 2>/dev/null)"
"$PY" examples/python-host/host.py "http://127.0.0.1:$SERVEPORT/v1" local:mock-mini | grep -q "status:  200" && pass "python" || fail "python"

echo "ENV_OK $NAME"