#!/usr/bin/env bash
# review_mode=on with four Codex roles launches exactly four Codex panes.

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
for s in join.sh delivery.sh leave.sh send.sh; do
  printf '#!/usr/bin/env bash\nprintf "%%s %%s\\n" "$0" "$*" >> "$AGMSG_LOG"\n' > "$TMP/agmsg/$s"
  chmod +x "$TMP/agmsg/$s"
done
cat > "$TMP/home/runners.json" <<'JSON'
{"default":"codex","runners":[{"name":"codex","command":"codex","engine":"codex"}]}
JSON
cat > "$TMP/roles.json" <<'JSON'
{"review_mode":"on","roles":{
 "design":{"runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh"},
 "design_review":{"runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"xhigh"},
 "exec":{"runner":"codex","engine":"codex","model":"gpt-5.6-terra","effort":"high"},
 "exec_review":{"runner":"codex","engine":"codex","model":"gpt-5.6-sol","effort":"high"}}}
JSON

fail=0
bad() { echo "FAIL: $1" >&2; fail=1; }
ARGV_LOG="$TMP/argv.log" AGMSG_LOG="$TMP/agmsg.log" AGMSG_DIR="$TMP/agmsg" \
DISPATCH_CONFIG_HOME="$TMP/home" bash "$TMP/scripts/prewarm-panes.sh" --with-design \
  --agmsg-team demo-team --roles "$TMP/roles.json" --cwd "$TMP/repo" --slug demo \
  --status-dir "$TMP/status" > "$TMP/result.json"

[[ $(wc -l < "$TMP/argv.log" | tr -d ' ') == 4 ]] || bad 'AC1 exactly four panes'
for role in design design_review exec exec_review; do
  grep -F -- "--role $role" "$TMP/argv.log" | grep -Fq -- '--runner codex' || bad "AC2 $role"
done
grep -Fq -- ' claude-code ' "$TMP/agmsg.log" && bad 'AC3 no claude-code wiring'
jq -e '.review_mode == "on" and
  ([.design,.design_review,.exec,.exec_review] | all(.engine == "codex" and .runner == "codex"))' \
  "$TMP/status/prewarm.json" >/dev/null || bad 'AC4 four-role Codex prewarm.json'
jq -e '.review_mode == "on" and (.panes | keys == ["design","design_review","exec","exec_review"])' \
  "$TMP/result.json" >/dev/null || bad 'AC5 stdout schema'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
