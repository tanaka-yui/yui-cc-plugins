#!/usr/bin/env bash
# prewarm-panes.sh の --unattended / --timeout-sentinel が各 standby 起動へ
# 正しく転送されることの検査。launch-workspace.sh と agmsg をスタブ化する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/prewarm-panes.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/repo" "$TMP/status" "$TMP/agmsg"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init

cp "$SRC" "$TMP/scripts/prewarm-panes.sh"

# launch-workspace.sh のスタブ: 引数を 1 行ずつ argv.log に記録して最小 JSON を返す
cat > "$TMP/scripts/launch-workspace.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$ARGV_LOG"
if [[ " $* " == *" --mode review "* ]]; then
  case "${FAIL_REVIEW:-}" in
    launch) exit 41 ;;
    parse) jq -n '{workspace_id:"workspace:1"}'; exit 0 ;;
  esac
fi
jq -n '{workspace_id:"workspace:1", surface_id:"surface:1"}'
STUB
chmod +x "$TMP/scripts/launch-workspace.sh"

# agmsg のスタブ (join / delivery / leave すべて成功扱い)
for s in join.sh delivery.sh leave.sh send.sh; do
  cat > "$TMP/agmsg/$s" <<'STUB'
#!/usr/bin/env bash
if [[ -n "${AGMSG_LOG:-}" ]]; then
  printf '%s %s\n' "$(basename "$0")" "$*" >> "$AGMSG_LOG"
fi
exit 0
STUB
  chmod +x "$TMP/agmsg/$s"
done

fail=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# argv.log の中で pattern を含む行がすべて flag を含むか
assert_all_lines_with() {
  local pattern="$1" flag="$2" label="$3" total matched
  total=$(grep -c -F -- "$pattern" "$TMP/argv.log" || true)
  matched=$(grep -F -- "$pattern" "$TMP/argv.log" | grep -c -F -- "$flag" || true)
  if [[ "$total" -gt 0 && "$total" == "$matched" ]]; then ok "$label"
  else bad "$label (pattern 一致 $total 行のうち flag を含むのは $matched 行)"; fi
}
assert_no_line_with() {
  local pattern="$1" flag="$2" label="$3"
  if grep -F -- "$pattern" "$TMP/argv.log" | grep -Fq -- "$flag"; then
    bad "$label (予期しない $flag)"
  else ok "$label"; fi
}

run_prewarm() {
  : > "$TMP/argv.log"
  ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" \
    bash "$TMP/scripts/prewarm-panes.sh" \
      --with-opus --agmsg-team demo-team \
      --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" "$@" >/dev/null
}

# --- U1: --unattended は設計 Claude ペインに --skip-permissions を渡す ---
run_prewarm --unattended
assert_all_lines_with "--role plan" "--skip-permissions" \
  'U1 --unattended は opus standby に --skip-permissions を渡す'

# --- U2: --unattended 無しでは opus に付かない（後方互換） ---
run_prewarm
assert_no_line_with "--role plan" "--skip-permissions" \
  'U2 --unattended 無しでは opus standby に付かない'

# --- U3: fixed codex は要求された3ペインだけへ sentinel を転送する ---
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

: > "$TMP/argv.log"
ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" \
    --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" \
    --design-runner codex --reviewer-runner codex \
    --exec-runner codex --exec-choice codex \
    --unattended --timeout-sentinel "$TMP/loop/timed-out/demo" >/dev/null

SENT="--timeout-sentinel $TMP/loop/timed-out/demo"
for pane in '--role plan' '--role exec' '--mode review'; do
  if grep -F -- "$pane" "$TMP/argv.log" | grep -Fq -- "$SENT"; then
    ok "U3 '$pane' の起動に sentinel が転送される"
  else
    bad "U3 '$pane' の起動に sentinel が転送されていない"
  fi
done
[[ $(wc -l < "$TMP/argv.log" | tr -d ' ') == 3 ]] \
  && ok 'U3 fixed codex は3ペインだけ起動する' \
  || bad 'U3 fixed codex の起動ペイン数が3ではない'
assert_no_line_with '--runner codex' '--model sonnet' 'U3 fixed codex は sonnet を起動しない'

# --- U4: ask は legacy candidate set の全ペインへ sentinel を転送する ---
cat > "$TMP/runners.json" <<'JSON'
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude", "review_model": "opus[1m]" },
    { "name": "codex",  "command": "codex",  "engine": "codex",  "review_model": "gpt-5.6-sol" }
  ]
}
JSON

: > "$TMP/argv.log"
ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" \
    --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" \
    --codex-runner codex --review-model gpt-5.6-sol --exec-choice ask \
    --unattended --timeout-sentinel "$TMP/loop/timed-out/demo" >/dev/null

for pane in 'opus[1m]' 'sonnet' '--role exec' '--mode review'; do
  if grep -F -- "$pane" "$TMP/argv.log" | grep -Fq -- "$SENT"; then
    ok "U4 ask '$pane' の起動に sentinel が転送される"
  else
    bad "U4 ask '$pane' の起動に sentinel が転送されていない"
  fi
done
[[ $(wc -l < "$TMP/argv.log" | tr -d ' ') == 4 ]] \
  && ok 'U4 ask は legacy candidate set の4ペインを起動する' \
  || bad 'U4 ask の起動ペイン数が4ではない'

# --- U5: fixed same-Codex reviewer と独立した Claude executor を opus/sonnet へ渡す ---
cat > "$TMP/runners.json" <<'JSON'
{
  "default": "codex",
  "runners": [
    { "name": "codex", "command": "codex", "engine": "codex", "plan_model": "gpt-5.6-sol", "review_model": "gpt-5.6-sol", "exec_model": "gpt-5.6-terra" },
    { "name": "claude-exec", "command": "claude", "engine": "claude" }
  ]
}
JSON

: > "$TMP/argv.log"
if ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" \
    --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" \
    --design-runner codex --reviewer-runner codex \
    --exec-runner claude-exec --exec-choice 'opus 1m' \
    --timeout-sentinel "$TMP/loop/timed-out/demo" >/dev/null; then
  opus_rc=0
else
  opus_rc=$?
fi

[[ $opus_rc -eq 0 ]] \
  && ok 'U5 fixed same-Codex review + opus executor を受理する' \
  || bad "U5 fixed same-Codex review + opus executor が失敗した (exit $opus_rc)"
grep -F -- '--runner claude-exec' "$TMP/argv.log" | grep -F -- '--role exec' | grep -Fq -- '--model opus[1m]' \
  && ok 'U5 opus executor は独立した解決済み runner を使う' \
  || bad 'U5 opus executor が解決済み runner を使っていない'
[[ $(wc -l < "$TMP/argv.log" | tr -d ' ') == 3 ]] \
  && ok 'U5 fixed opus は design/review/opus だけを起動する' \
  || bad 'U5 fixed opus が不要な executor を起動した'
grep -F -- '--runner codex' "$TMP/argv.log" | grep -Fq -- '--mode review' \
  && ok 'U5 reviewer は executor と独立して Codex のまま' \
  || bad 'U5 reviewer が Codex runner ではない'
jq -e '.review.runner == "codex" and .executors.opus.runner == "claude-exec"' \
  "$TMP/status/prewarm.json" >/dev/null \
  && ok 'U5 opus の prewarm.json は独立 runner を記録する' \
  || bad 'U5 opus の prewarm.json runner が不正'

: > "$TMP/argv.log"
if ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  bash "$TMP/scripts/prewarm-panes.sh" \
    --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" \
    --design-runner codex --reviewer-runner codex \
    --exec-runner claude-exec --exec-choice sonnet >/dev/null; then
  sonnet_rc=0
else
  sonnet_rc=$?
fi
[[ $sonnet_rc -eq 0 ]] \
  && ok 'U5 fixed same-Codex review + sonnet executor を受理する' \
  || bad "U5 fixed same-Codex review + sonnet executor が失敗した (exit $sonnet_rc)"
grep -F -- '--runner claude-exec' "$TMP/argv.log" | grep -F -- '--role exec' | grep -Fq -- '--model sonnet' \
  && ok 'U5 sonnet executor は独立した解決済み runner を使う' \
  || bad 'U5 sonnet executor が解決済み runner を使っていない'
[[ $(wc -l < "$TMP/argv.log" | tr -d ' ') == 3 ]] \
  && ok 'U5 fixed sonnet は design/review/sonnet だけを起動する' \
  || bad 'U5 fixed sonnet が不要な executor を起動した'
jq -e '.review.runner == "codex" and .executors.sonnet.runner == "claude-exec"' \
  "$TMP/status/prewarm.json" >/dev/null \
  && ok 'U5 sonnet の prewarm.json は独立 runner を記録する' \
  || bad 'U5 sonnet の prewarm.json runner が不正'

# --- U6: Codex design の ask/unset は提示する3 choiceをすべて解決済み runner で起動する ---
run_dynamic_candidates() {
  local label="$1"
  shift
  : > "$TMP/argv.log"
  rm -f "$TMP/status/prewarm.json"
  if ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$TMP/scripts/prewarm-panes.sh" \
      --with-design --agmsg-team demo-team \
      --cwd "$TMP/repo" --slug "demo-$label" --status-dir "$TMP/status" \
      --design-runner codex --reviewer-runner codex \
      --claude-runner claude-exec --codex-runner codex "$@" >/dev/null; then
    dynamic_rc=0
  else
    dynamic_rc=$?
  fi
  [[ $dynamic_rc -eq 0 ]] \
    && ok "U6 Codex design + $label を受理する" \
    || bad "U6 Codex design + $label が失敗した (exit $dynamic_rc)"
  [[ $(wc -l < "$TMP/argv.log" | tr -d ' ') == 5 ]] \
    && ok "U6 $label は design/review + 3 executors を起動する" \
    || bad "U6 $label の起動ペイン数が5ではない"
  jq -e '.review.runner == "codex" and .review.engine == "codex" and
    .executors.opus.runner == "claude-exec" and .executors.opus.engine == "claude" and
    .executors.sonnet.runner == "claude-exec" and .executors.sonnet.engine == "claude" and
    .executors.codex.runner == "codex" and .executors.codex.engine == "codex"' \
    "$TMP/status/prewarm.json" >/dev/null 2>&1 \
    && ok "U6 $label の全 advertised choice に正しい executor tuple がある" \
    || bad "U6 $label の executor tuple が不正"
  grep -F -- '--runner claude-exec' "$TMP/argv.log" | grep -F -- '--role exec' | grep -Fq -- '--model opus[1m]' \
    && ok "U6 $label の opus は明示 Claude runner を使う" \
    || bad "U6 $label の opus runner が不正"
  grep -F -- '--runner claude-exec' "$TMP/argv.log" | grep -F -- '--role exec' | grep -Fq -- '--model sonnet' \
    && ok "U6 $label の sonnet は明示 Claude runner を使う" \
    || bad "U6 $label の sonnet runner が不正"
}

run_dynamic_candidates ask --exec-choice ask
run_dynamic_candidates unset

# --- U7: review pane launch/output failure は join を即 leave し Phase B panes を保持する ---
for failure_mode in launch parse; do
  : > "$TMP/argv.log"
  : > "$TMP/agmsg.log"
  rm -f "$TMP/status/prewarm.json"
  if FAIL_REVIEW="$failure_mode" ARGV_LOG="$TMP/argv.log" AGMSG_LOG="$TMP/agmsg.log" \
    AGMSG_DIR="$TMP/agmsg" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$TMP/scripts/prewarm-panes.sh" \
      --with-design --agmsg-team demo-team \
      --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" \
      --design-runner codex --reviewer-runner codex \
      --exec-runner claude-exec --exec-choice sonnet >/dev/null; then
    review_fail_rc=0
  else
    review_fail_rc=$?
  fi
  [[ $review_fail_rc -eq 0 ]] \
    && ok "U7 review pane $failure_mode failure でも dispatch を継続する" \
    || bad "U7 review pane $failure_mode failure が dispatch を中断した (exit $review_fail_rc)"
  jq -e '.design and .executors.sonnet and (.review == null)' "$TMP/status/prewarm.json" >/dev/null 2>&1 \
    && ok "U7 $failure_mode failure では review を省略し design/executor を保持する" \
    || bad "U7 $failure_mode failure 時の review omission または design/executor が不正"
  [[ $(grep -Fc -- 'join.sh demo-team demo-review codex' "$TMP/agmsg.log" || true) == 1 ]] \
    && ok "U7 $failure_mode failure 前に review member を1回 join する" \
    || bad "U7 $failure_mode failure 前の review join 回数が不正"
  [[ $(grep -Fc -- 'leave.sh demo-team demo-review' "$TMP/agmsg.log" || true) == 1 ]] \
    && ok "U7 $failure_mode failure 後に review member を1回 leave する" \
    || bad "U7 $failure_mode failure 後の review leave 回数が不正"
done

# --- U8: --timeout-sentinel 未指定なら一切現れない ---
run_prewarm
assert_no_line_with "--mode standby" "--timeout-sentinel" 'U8 未指定時は sentinel を渡さない'

# --- U9: --with-opus は --with-design の後方互換 alias ---
: > "$TMP/argv.log"
ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" \
  bash "$TMP/scripts/prewarm-panes.sh" \
    --with-opus --agmsg-team demo-team \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" >/dev/null
opus_design=$(grep -F -- '--role plan' "$TMP/argv.log" || true)

: > "$TMP/argv.log"
ARGV_LOG="$TMP/argv.log" AGMSG_DIR="$TMP/agmsg" \
  bash "$TMP/scripts/prewarm-panes.sh" \
    --with-design --agmsg-team demo-team \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" >/dev/null
design_design=$(grep -F -- '--role plan' "$TMP/argv.log" || true)
[[ -n "$opus_design" && "$opus_design" == "$design_design" ]] \
  && ok 'U9 --with-opus と --with-design は同じ design-role request を作る' \
  || bad 'U9 --with-opus と --with-design の design-role request が異なる'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
