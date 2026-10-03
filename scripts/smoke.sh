#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

HOST="${SMOKE_HOST:-http://localhost:${PORT:-3000}}"
TOKEN="${SERVICE_TOKEN:-}"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; exit 1; }

auth_header=()
if [ -n "$TOKEN" ]; then
  auth_header=(-H "Authorization: Bearer $TOKEN")
fi

health=$(curl -sf "$HOST/health") || fail "GET /health unreachable"
echo "$health" | grep -q '"ok":true' && pass "/health ok ($health)" || fail "/health did not return ok:true"

groups=$(curl -sf "${auth_header[@]}" "$HOST/groups") || fail "GET /groups failed"
echo "$groups" | grep -q '"groups"' && pass "/groups ok" || fail "/groups response malformed"

if [ -n "${SMOKE_CHAT_ID:-}" ]; then
  send=$(curl -sf -X POST "${auth_header[@]}" -H 'Content-Type: application/json' \
    -d "{\"chat_id\":\"$SMOKE_CHAT_ID\",\"text\":\"smoke test $(date +%s)\"}" \
    "$HOST/send") || fail "POST /send failed"
  echo "$send" | grep -q '"ok":true' && pass "/send ok" || fail "/send response malformed"
else
  echo "SKIP: /send (SMOKE_CHAT_ID not set)"
fi

echo "All smoke checks passed."
