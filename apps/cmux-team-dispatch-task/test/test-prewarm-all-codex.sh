#!/usr/bin/env bash
# all-Codex の prewarm が plan/review/exec の3ペインだけを起動し、
# Claude/sonnet の pane・agmsg 配線を作らないことを検査する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREWARM="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/repo" "$TMP/status" "$TMP/agmsg"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

cp "$PREWARM" "$TMP/scripts/prewarm-panes.sh"

cat > "$TMP/scripts/launch-workspace.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$ARGV_LOG"
count=$(wc -l < "$ARGV_LOG" | tr -d ' ')
jq -n --arg surface "surface:$count" '{workspace_id:"workspace:1", surface_id:$surface}'
STUB
chmod +x "$TMP/scripts/launch-workspace.sh"

for s in join.sh delivery.sh leave.sh send.sh; do
  cat > "$TMP/agmsg/$s" <<'STUB'
#!/usr/bin/env bash
echo "$0 $*" >> "$AGMSG_LOG"
if [[ "$(basename "$0")" == "delivery.sh" ]]; then
  echo 'AGMSG-DIRECTIVE: stub'
fi
STUB
  chmod +x "$TMP/agmsg/$s"
done

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "codex",
  "runners": [
    {
      "name": "codex",
      "command": "codex",
      "engine": "codex",
      "plan_model": "gpt-5.6-sol",
      "review_model": "gpt-5.6-sol",
      "exec_model": "gpt-5.6-terra"
    }
  ]
}
JSON

fail=0
bad() { echo "FAIL: $1" >&2; fail=1; }

ARGV_LOG="$TMP/argv.log" AGMSG_LOG="$TMP/agmsg.log" \
AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
bash "$TMP/scripts/prewarm-panes.sh" --with-design --agmsg-team demo-team \
  --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" \
  --design-runner codex --reviewer-runner codex \
  --exec-runner codex --exec-choice codex > "$TMP/result.json"

[[ $(wc -l < "$TMP/argv.log" | tr -d ' ') == 3 ]] || bad 'AC1 exactly three panes'
grep -F -- '--runner codex' "$TMP/argv.log" | grep -Fq -- '--role plan' || bad 'AC2 design role'
grep -F -- '--mode review' "$TMP/argv.log" | grep -F -- '--runner codex' | grep -Fq -- '--role review' || bad 'AC3 review role'
grep -F -- '--runner codex' "$TMP/argv.log" | grep -Fq -- '--role exec' || bad 'AC4 exec role'
grep -Fq -- '--model sonnet' "$TMP/argv.log" && bad 'AC5 no sonnet pane'
grep -Fq -- ' claude-code ' "$TMP/agmsg.log" && bad 'AC6 no claude-code wiring'
jq -e '.design.engine == "codex" and .review.engine == "codex" and
  .executors.codex.engine == "codex" and (.executors.sonnet == null)' \
  "$TMP/status/prewarm.json" >/dev/null || bad 'AC7 role-aware prewarm.json'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
