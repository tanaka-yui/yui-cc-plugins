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
  rename-workspace) [[ -z "${FAIL_RENAME_WORKSPACE:-}" ]] ;;
  send) [[ -z "${FAIL_CMUX_SEND:-}" ]] ;;
  rename-tab|notify|send-key|wait-for|identify|close-surface|close-workspace) ;;
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

# L5: prewarm-panes.sh の実 callsite と同じ review/exec_review 引数を、stub ではなく
# 実 launcher の引数検証へ通す。mode matrix から review:exec_review が落ちる変異を捕捉する。
CMUX_CALL_LOG="$TMP/calls-l5.log"; export CMUX_CALL_LOG
: > "$CMUX_CALL_LOG"
if run_launch --cwd "$TMP/repo" --mode review --role exec_review \
     --standby-in workspace:5 --standby-split-from surface:6 --standby-split-direction right \
     --status-dir "$TMP/status-exec-review" l5-exec-review >/dev/null 2>"$TMP/l5.err"; then
  grep -Fq 'new-split right --workspace workspace:5 --surface surface:6' "$CMUX_CALL_LOG" \
    && pass 'L5 review:exec_review reaches the real launcher split path' \
    || bad 'L5 review:exec_review did not reach the real launcher split path'
else
  bad "L5 review:exec_review was rejected: $(tr '\n' ' ' < "$TMP/l5.err")"
fi

# L6: review sandbox は status dir 配下の実ディレクトリに限定する。symlink の外側へ
# Codex の --add-dir を向ける変異は、pane 構築前に拒否しなければならない。
mkdir -p "$TMP/outside-review" "$TMP/status-symlink"
ln -s "$TMP/outside-review" "$TMP/status-symlink/review"
CMUX_CALL_LOG="$TMP/calls-l6.log"; export CMUX_CALL_LOG
: > "$CMUX_CALL_LOG"
if run_launch --cwd "$TMP/repo" --mode review --role design_review \
     --standby-in workspace:5 --standby-split-from surface:6 --standby-split-direction right \
     --status-dir "$TMP/status-symlink" l6-design-review >/dev/null 2>"$TMP/l6.err"; then
  bad 'L6 symlinked review sandbox was accepted'
elif [[ ! -s "$CMUX_CALL_LOG" ]] && grep -qiE 'review directory|symlink|unsafe' "$TMP/l6.err"; then
  pass 'L6 symlinked review sandbox is rejected before cmux construction'
else
  bad "L6 rejection was late or unclear: $(tr '\n' ' ' < "$TMP/l6.err")"
fi

# L7: the real launcher owns a split as soon as new-split returns its surface ID.
# A later runner-command send failure must close that exact surface before exit.
CMUX_CALL_LOG="$TMP/calls-l7.log"; export CMUX_CALL_LOG
: > "$CMUX_CALL_LOG"
if FAIL_CMUX_SEND=1 run_launch --cwd "$TMP/repo" --mode standby \
     --standby-in workspace:5 --standby-split-from surface:6 \
     --status-dir "$TMP/status-l7" l7-standby >/dev/null 2>"$TMP/l7.err"; then
  bad 'L7 split send failure was accepted'
elif [[ $(grep -c '^close-surface --workspace workspace:5 --surface surface:3$' "$CMUX_CALL_LOG" || true) == 1 ]]; then
  pass 'L7 split send failure closes the launcher-owned surface'
else
  bad "L7 split send failure leaked its surface: $(tr '\n' ' ' < "$CMUX_CALL_LOG")"
fi

# L8: workspace placement has the same ownership rule after new-workspace returns an ID.
CMUX_CALL_LOG="$TMP/calls-l8.log"; export CMUX_CALL_LOG
: > "$CMUX_CALL_LOG"
if FAIL_RENAME_WORKSPACE=1 run_launch --cwd "$TMP/repo" --mode superpowers \
     --status-dir "$TMP/status-l8" l8-task 'do something' >/dev/null 2>"$TMP/l8.err"; then
  bad 'L8 workspace rename failure was accepted'
elif [[ $(grep -c '^close-workspace --workspace workspace:1$' "$CMUX_CALL_LOG" || true) == 1 ]]; then
  pass 'L8 post-create workspace failure closes the launcher-owned workspace'
else
  bad "L8 post-create workspace failure leaked its workspace: $(tr '\n' ' ' < "$CMUX_CALL_LOG")"
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
