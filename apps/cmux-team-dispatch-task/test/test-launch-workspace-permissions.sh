#!/usr/bin/env bash
# launch-workspace.sh が claude engine の worktree に注入する
# .claude/settings.local.json の permissions.defaultMode の回帰テスト。
# 検証項目: 全 MODE への注入 / codex engine 非対象 / 既存キー保持 / 冪等性 /
# superpowers にフラグを足していないこと / info/exclude の追記。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  new-workspace) echo 'workspace:1' ;;
  list-pane-surfaces) echo 'surface:2' ;;
  new-split) echo 'surface:3' ;;
  rename-workspace|rename-tab|notify|send|send-key|wait-for|identify) ;;
  *) echo "unexpected cmux command: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"

cat > "$TMP/runners.json" <<'JSON'
{
  "default": "claude",
  "runners": [
    { "name": "claude", "command": "claude", "engine": "claude" },
    { "name": "codex", "command": "codex", "engine": "codex" }
  ]
}
JSON

fail=0

pass() { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }

new_repo() {
  local name="$1"
  local dir="$TMP/repo-$name"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.invalid
  git -C "$dir" config user.name test
  touch "$dir/.gitkeep"
  git -C "$dir" add .gitkeep
  git -C "$dir" commit -qm init
  echo "$dir"
}

run_launch() {
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
    bash "$LAUNCH" "$@"
}

settings_of() { echo "$1/.claude/settings.local.json"; }

default_mode_of() {
  jq -r '.permissions.defaultMode // ""' "$(settings_of "$1")" 2>/dev/null || echo ""
}

# --- P1: claude engine + superpowers ---
repo=$(new_repo p1)
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p1" p1-task 'do something' >/dev/null
[[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
  && pass 'P1 superpowers injects defaultMode=bypassPermissions' \
  || bad  'P1 superpowers injects defaultMode=bypassPermissions'

# --- P2: claude engine + plan で ExitPlanMode hook と共存する ---
repo=$(new_repo p2)
run_launch --cwd "$repo" --mode plan --runner claude \
  --status-dir "$TMP/status-p2" p2-task 'do something' >/dev/null
[[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
  && pass 'P2a plan injects defaultMode' || bad 'P2a plan injects defaultMode'
if jq -e '.hooks.PostToolUse[] | select(.matcher == "ExitPlanMode")' \
     "$(settings_of "$repo")" >/dev/null 2>&1; then
  pass 'P2b plan keeps the ExitPlanMode hook'
else
  bad 'P2b plan keeps the ExitPlanMode hook'
fi

# --- P3: codex engine は注入しない ---
repo=$(new_repo p3)
run_launch --cwd "$repo" --mode superpowers --runner codex \
  --status-dir "$TMP/status-p3" p3-task 'do something' >/dev/null
[[ ! -f "$(settings_of "$repo")" ]] \
  && pass 'P3 codex engine writes no settings.local.json' \
  || bad  'P3 codex engine writes no settings.local.json'

# --- P4: 既存キーが保持される ---
repo=$(new_repo p4)
mkdir -p "$repo/.claude"
cat > "$(settings_of "$repo")" <<'JSON'
{ "env": { "FOO": "bar" }, "permissions": { "allow": ["Bash(ls:*)"] } }
JSON
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p4" p4-task 'do something' >/dev/null
if [[ "$(jq -r '.env.FOO' "$(settings_of "$repo")")" == "bar" \
   && "$(jq -r '.permissions.allow[0]' "$(settings_of "$repo")")" == "Bash(ls:*)" \
   && "$(default_mode_of "$repo")" == "bypassPermissions" ]]; then
  pass 'P4 existing keys survive the merge'
else
  bad 'P4 existing keys survive the merge'
fi

# --- P5: 冪等 (同じ worktree に 2 回実行しても内容が変わらない) ---
repo=$(new_repo p5)
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p5" p5-task 'do something' >/dev/null
first=$(cat "$(settings_of "$repo")" 2>/dev/null || echo '<missing>')
run_launch --cwd "$repo" --mode standby --runner claude \
  --status-dir "$TMP/status-p5" p5-standby >/dev/null
second=$(cat "$(settings_of "$repo")" 2>/dev/null || echo '<missing>')
if [[ "$first" == "$second" && "$first" != '<missing>' ]]; then
  pass 'P5 second launch is idempotent'
else
  bad 'P5 second launch is idempotent'
fi

# --- P6: superpowers に --dangerously-skip-permissions を足していない ---
repo=$(new_repo p6)
out=$(run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p6" p6-task 'do something')
runner_file=$(jq -r '.runner_file' <<<"$out")
if grep -Fq -- '--dangerously-skip-permissions' "$runner_file"; then
  bad 'P6 superpowers must not gain --dangerously-skip-permissions'
else
  pass 'P6 superpowers must not gain --dangerously-skip-permissions'
fi

# --- P7: superpowers でも info/exclude に追記される ---
repo=$(new_repo p7)
run_launch --cwd "$repo" --mode superpowers --runner claude \
  --status-dir "$TMP/status-p7" p7-task 'do something' >/dev/null
exclude=$(git -C "$repo" rev-parse --path-format=absolute --git-path info/exclude)
if grep -qxF '.claude/settings.local.json' "$exclude" \
   && grep -qxF '.claude/plans/' "$exclude"; then
  pass 'P7 info/exclude gains both entries in superpowers mode'
else
  bad 'P7 info/exclude gains both entries in superpowers mode'
fi

# --- P8: execute モード ---
repo=$(new_repo p8)
run_launch --cwd "$repo" --mode execute --runner claude \
  --plan-file "$TMP/plan.md" --status-dir "$TMP/status-p8" p8-task >/dev/null
[[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
  && pass 'P8 execute injects defaultMode' || bad 'P8 execute injects defaultMode'

# --- P9: standby + --skip-permissions (sonnet standby 相当) はフラグと共存する ---
repo=$(new_repo p9)
out=$(run_launch --cwd "$repo" --mode standby --runner claude \
  --model sonnet --skip-permissions --status-dir "$TMP/status-p9" p9-standby)
runner_file=$(jq -r '.runner_file' <<<"$out")
if [[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
   && grep -Fq -- '--dangerously-skip-permissions' "$runner_file"; then
  pass 'P9 standby keeps the flag and gains the settings injection'
else
  bad 'P9 standby keeps the flag and gains the settings injection'
fi

# --- P10: review モード ---
repo=$(new_repo p10)
run_launch --cwd "$repo" --mode review --runner claude \
  --status-dir "$TMP/status-p10" p10-review >/dev/null
[[ "$(default_mode_of "$repo")" == "bypassPermissions" ]] \
  && pass 'P10 review injects defaultMode' || bad 'P10 review injects defaultMode'

# --- P11: info/exclude を解決できない cwd (非 git) でも launch が成功する ---
plain="$TMP/plain-dir"
mkdir -p "$plain"
if run_launch --cwd "$plain" --mode superpowers --runner claude \
     --status-dir "$TMP/status-p11" p11-task 'do something' >/dev/null 2>&1; then
  if [[ "$(default_mode_of "$plain")" == "bypassPermissions" ]]; then
    pass 'P11 non-git cwd still launches and gets the injection'
  else
    bad 'P11 non-git cwd still launches and gets the injection'
  fi
else
  bad 'P11 non-git cwd must not abort the launch'
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
