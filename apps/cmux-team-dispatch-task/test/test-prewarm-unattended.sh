#!/usr/bin/env bash
# --unattended and --timeout-sentinel forwarding under the four-role contract.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/repo" "$TMP/status" "$TMP/agmsg" "$TMP/home"
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
cat > "$TMP/roles.json" <<'JSON'
{"review_mode":"on","roles":{
 "design":{"runner":"claude","engine":"claude","model":"opus[1m]","effort":"xhigh"},
 "design_review":{"runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh"},
 "exec":{"runner":"claude","engine":"claude","model":"sonnet","effort":"high"},
 "exec_review":{"runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"high"}}}
JSON

fail=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }
run_prewarm() {
  : > "$TMP/argv.log"
  ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" DISPATCH_CONFIG_HOME="$TMP/home" \
    env -u CODEX_THREAD_ID bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team team --roles "$TMP/roles.json" \
      --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" "$@" >/dev/null
}
role_line() { grep -F -- "--role $1 " "$TMP/argv.log" || true; }

run_prewarm --unattended
[[ "$(role_line design)" == *'--skip-permissions'* ]] && ok 'U1 unattended grants design bypass' || bad 'U1'
run_prewarm
[[ "$(role_line design)" != *'--skip-permissions'* ]] && ok 'U2 attended design has no bypass' || bad 'U2'
[[ "$(role_line exec)" == *'--skip-permissions'* ]] && ok 'U2b claude exec keeps bypass' || bad 'U2b'

sentinel="$TMP/timed-out/demo"
run_prewarm --timeout-sentinel "$sentinel"
for role in design design_review exec exec_review; do
  [[ "$(role_line "$role")" == *"--timeout-sentinel $sentinel"* ]] || bad "U3 sentinel missing on $role"
done
ok 'U3 sentinel reaches all four roles'
run_prewarm
grep -q -- '--timeout-sentinel' "$TMP/argv.log" && bad 'U4 unexpected sentinel' || ok 'U4 omitted sentinel stays absent'

: > "$TMP/argv.log"
rc=0
out=$(CODEX_THREAD_ID=t ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" DISPATCH_CONFIG_HOME="$TMP/home" \
  bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team team --roles "$TMP/roles.json" \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" --unattended 2>&1) || rc=$?
[[ $rc -ne 0 && "$out" == *'--unattended is refused from a codex parent'* && ! -s "$TMP/argv.log" ]] \
  && ok 'U5 unattended Codex parent fails before launch' || bad 'U5'

: > "$TMP/argv.log"
ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" DISPATCH_CONFIG_HOME="$TMP/home" \
  env -u CODEX_THREAD_ID bash "$TMP/scripts/prewarm-panes.sh" --with-opus --agmsg-team team --roles "$TMP/roles.json" \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" >/dev/null
[[ "$(grep -c -- '--role design ' "$TMP/argv.log")" == 1 ]] \
  && ok 'U6 with-opus remains an alias for with-design' || bad 'U6'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
