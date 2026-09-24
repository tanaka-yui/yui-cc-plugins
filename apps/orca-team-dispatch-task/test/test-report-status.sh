#!/usr/bin/env bash
# Stage 1 の helper は done/error を記録するだけで、PR や第 2 ロールには依存しない。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
SD=$(mktemp -d); trap 'rm -rf "$SD"' EXIT

mkdir -p "$SD/.deferred"
echo '{"integration":"pr"}' > "$SD/integration.json"
node "$P/skills/orca-team-dispatch-task/scripts/report-status.ts" "$SD" done complete >/dev/null 2>&1; rc=$?
jq -e '.status == "done" and .message == "complete"' "$SD/status.json" >/dev/null 2>&1 \
  && [[ "$rc" -eq 0 ]] && ok "RS1 Stage 1 は PR/delegation gate 無しで done" \
  || fail "RS1 (rc=$rc)"

node "$P/skills/orca-team-dispatch-task/scripts/report-status.ts" "$SD" bogus >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "RS2 不正 status は拒否" || fail "RS2 (rc=$rc)"
# RS3: zsh から呼んでも同じ結果になる（設計 3-5。worker の端末は zsh のことがある）。残りの語は 1 つの message になる
if command -v zsh >/dev/null 2>&1; then
  rm -f "$SD/status.json"
  zsh -c 'node "$1" "$2" error two words' zsh "$P/skills/orca-team-dispatch-task/scripts/report-status.ts" "$SD" >/dev/null 2>&1; rc=$?
  jq -e '.status == "error" and .message == "two words"' "$SD/status.json" >/dev/null 2>&1 && [[ "$rc" -eq 0 ]] \
    && ok "RS3 zsh から呼んでも同じ結果" || fail "RS3 (rc=$rc)"
else
  echo "SKIP: RS3 zsh が無い"
fi
echo "---"; echo "failures: $fails"; exit "$fails"
