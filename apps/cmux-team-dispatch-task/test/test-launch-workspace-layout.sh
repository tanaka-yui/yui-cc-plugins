#!/usr/bin/env bash
# launch-workspace.sh のレイアウト固定 (workspace のみ) の回帰テスト。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/status"

# agmsg send.sh の stub。--status-dir を渡す launch は agmsg 識別子を要求するので
# (配送は agmsg send.sh の 1 本だけで、タイプ入力への fallback が無い)、
# 実体の存在チェックを通すためにこれを AGMSG_SEND として export する。
mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/agmsg-send.sh"
chmod +x "$TMP/bin/agmsg-send.sh"
export AGMSG_SEND="$TMP/bin/agmsg-send.sh"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$CMUX_CALL_LOG"
case "$1" in
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  new-split) echo 'surface:3' ;;
  rename-workspace|rename-tab|notify|send|send-key|wait-for|identify) ;;
  read-screen) echo '$ ' ;;
  *) echo "unexpected cmux command: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "claude",
  "runners": [ { "name": "claude", "command": "claude", "engine": "claude" } ]
}
JSON

fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

run_launch() {
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    CMUX_CALL_LOG="${CMUX_CALL_LOG:-$TMP/calls.log}" \
    bash "$LAUNCH" --agmsg-team demo-team --agmsg-from layout-probe "$@"
}

for flag_pair in "--layout workspace" "--layout split" "--split-from surface:9" \
                 "--split-direction right" "--parent-workspace workspace:9"; do
  flag_name="${flag_pair%% *}"
  # shellcheck disable=SC2086
  if run_launch --cwd "$TMP/repo" --mode superpowers $flag_pair \
       --status-dir "$TMP/status" l1-task 'do something' > "$TMP/l1.out" 2>&1; then
    bad "L1 '$flag_pair' was accepted (must be rejected)"
  elif grep -Fq -- "$flag_name" "$TMP/l1.out" && grep -Fq 'was removed' "$TMP/l1.out"; then
    pass "L1 '$flag_pair' is rejected by the explicit removed-option case"
  else
    bad "L1 '$flag_pair' failed but not via the removed-option case: $(tr '\n' ' ' < "$TMP/l1.out")"
  fi
done

CMUX_CALL_LOG="$TMP/calls-l2.log"; export CMUX_CALL_LOG
: > "$CMUX_CALL_LOG"
out=$(run_launch --cwd "$TMP/repo" --mode superpowers --status-dir "$TMP/status" l2-task 'do something')
runner_file=$(jq -r '.runner_file' <<<"$out")

if grep -Fq 'claude-teams' "$runner_file"; then
  bad 'L2 composed command must not mention claude-teams'
else
  pass 'L2 composed command must not mention claude-teams'
fi

[[ "$(jq -r '.layout' <<<"$out")" == "workspace" ]] \
  && pass 'L4a stdout JSON layout is the constant workspace' \
  || bad 'L4a stdout JSON layout is the constant workspace'
[[ "$(jq -r '.layout' "$TMP/status/status.json")" == "workspace" ]] \
  && pass 'L4b status.json layout is the constant workspace' \
  || bad 'L4b status.json layout is the constant workspace'
if jq -e 'has("split_from") or has("split_direction")' <<<"$out" >/dev/null; then
  bad 'L4c stdout JSON must not carry split_from / split_direction'
else
  pass 'L4c stdout JSON must not carry split_from / split_direction'
fi

CMUX_CALL_LOG="$TMP/calls-l3.log"; export CMUX_CALL_LOG
: > "$CMUX_CALL_LOG"
run_launch --cwd "$TMP/repo" --mode standby --standby-in workspace:5 \
  --standby-split-from surface:6 --standby-split-direction right \
  --status-dir "$TMP/status-standby" l3-standby >/dev/null
if grep -Fq 'new-split right --workspace workspace:5 --surface surface:6' "$CMUX_CALL_LOG"; then
  pass 'L3 standby split still calls cmux new-split'
else
  bad 'L3 standby split still calls cmux new-split'
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
