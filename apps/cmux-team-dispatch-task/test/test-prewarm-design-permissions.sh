#!/usr/bin/env bash
# Claude design relies on settings injection; Claude non-design panes receive bypass.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/repo" "$TMP/agmsg" "$TMP/home"
cp "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh" \
  "$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/config-lib.sh" "$TMP/scripts/"
cat > "$TMP/scripts/launch-workspace.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$ARGV_LOG"
count=$(wc -l < "$ARGV_LOG" | tr -d ' ')
jq -n --arg surface "surface:$count" '{workspace_id:"workspace:1",surface_id:$surface}'
STUB
chmod +x "$TMP/scripts/launch-workspace.sh"
for s in join.sh delivery.sh leave.sh send.sh; do printf '#!/bin/sh\nexit 0\n' > "$TMP/agmsg/$s"; chmod +x "$TMP/agmsg/$s"; done
cat > "$TMP/home/runners.json" <<'JSON'
{"default":"claude","runners":[{"name":"claude","command":"claude","engine":"claude"},{"name":"codex","command":"codex","engine":"codex"}]}
JSON
cat > "$TMP/claude.json" <<'JSON'
{"review_mode":"off","roles":{"design":{"runner":"claude","engine":"claude","model":"opus[1m]","effort":"xhigh"},"exec":{"runner":"claude","engine":"claude","model":"sonnet","effort":"high"}}}
JSON
cat > "$TMP/codex.json" <<'JSON'
{"review_mode":"off","roles":{"design":{"runner":"codex","engine":"codex","effort":"xhigh"},"exec":{"runner":"codex","engine":"codex","effort":"high"}}}
JSON

fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }
run_case() {
  : > "$TMP/argv.log"
  ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" DISPATCH_CONFIG_HOME="$TMP/home" \
    bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team team --roles "$1" \
      --cwd "$TMP/repo" --slug db --status-dir "$TMP/status" >/dev/null
}
line() { grep -F -- "--role $1 " "$TMP/argv.log"; }

run_case "$TMP/claude.json"
[[ "$(line design)" != *'--skip-permissions'* ]] && pass 'DB1 Claude design has no bypass flag' || bad 'DB1 design'
[[ "$(line exec)" == *'--skip-permissions'* ]] && pass 'DB1 Claude exec has bypass flag' || bad 'DB1 exec'
run_case "$TMP/codex.json"
[[ "$(line design)" != *'--skip-permissions'* && "$(line exec)" != *'--skip-permissions'* ]] \
  && pass 'DB2 Codex panes have no Claude bypass flag' || bad 'DB2'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
