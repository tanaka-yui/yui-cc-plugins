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
jq -n '{workspace_id:"workspace:1", surface_id:"surface:1"}'
STUB
chmod +x "$TMP/scripts/launch-workspace.sh"

# agmsg のスタブ (join / delivery / leave すべて成功扱い)
for s in join.sh delivery.sh leave.sh send.sh; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/agmsg/$s"
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
      --with-opus --message-type agmsg --agmsg-team demo-team \
      --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" "$@" >/dev/null
}

# --- U1: --unattended は設計 opus ペインに --skip-permissions を渡す ---
run_prewarm --unattended
assert_all_lines_with "--mode standby --defer-status --model opus[1m]" "--skip-permissions" \
  'U1 --unattended は opus standby に --skip-permissions を渡す'

# --- U2: --unattended 無しでは opus に付かない（後方互換） ---
run_prewarm
assert_no_line_with "--mode standby --defer-status --model opus[1m]" "--skip-permissions" \
  'U2 --unattended 無しでは opus standby に付かない'

# --- U3: status 所有者になり得る全ペインへ sentinel を転送する ---
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
    --with-opus --message-type agmsg --agmsg-team demo-team \
    --cwd "$TMP/repo" --slug demo --status-dir "$TMP/status" \
    --codex-runner codex --review-model gpt-5.6-sol \
    --unattended --timeout-sentinel "$TMP/loop/timed-out/demo" >/dev/null

SENT="--timeout-sentinel $TMP/loop/timed-out/demo"
for pane in 'opus[1m]' 'sonnet' '--runner codex' '--mode review'; do
  if grep -F -- "$pane" "$TMP/argv.log" | grep -Fq -- "$SENT"; then
    ok "U3 '$pane' の起動に sentinel が転送される"
  else
    bad "U3 '$pane' の起動に sentinel が転送されていない"
  fi
done
[[ $(grep -c -- '--mode standby\|--mode review' "$TMP/argv.log") -ge 4 ]] \
  && ok 'U3 status 所有者候補が 4 つ以上起動された' \
  || bad 'U3 起動されたペインが 4 つ未満'

# --- U4: --timeout-sentinel 未指定なら一切現れない ---
run_prewarm
assert_no_line_with "--mode standby" "--timeout-sentinel" 'U4 未指定時は sentinel を渡さない'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
