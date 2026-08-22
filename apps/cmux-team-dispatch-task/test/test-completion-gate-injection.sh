#!/usr/bin/env bash
# completion gate の hook 注入。
#
# launch-workspace.sh は source すると最後まで実行されて die するので、既存の
# test-launch-workspace-*.sh と同じく **実プロセスとして起動して** 生成物を検査する。
#
#   CI1.  claude engine では .claude/settings.local.json の Stop に 1 本入る
#   CI1b. 注入された command が role / agent / status-dir を持つ
#   CI2.  同じ worktree で 2 回起動しても二重に入らない
#   CI3.  既存の hook (ExitPlanMode) を壊さない
#   CI4.  codex engine では .codex/hooks.json の Stop に 1 本入る
#   CI5.  codex でも二重に入らない
#   CI6.  agmsg が書いた SessionStart を壊さない (上書きせずマージする)
#   CI7.  .claude/settings.local.json と .codex/hooks.json が info/exclude に入る

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/launch-workspace.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

mkdir -p "$TMP/bin" "$TMP/repo/.claude" "$TMP/repo/.codex" "$TMP/status"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email test@example.invalid
git -C "$TMP/repo" config user.name test
touch "$TMP/repo/.gitkeep"
git -C "$TMP/repo" add .gitkeep
git -C "$TMP/repo" commit -qm init
printf 'plan\n' > "$TMP/plan.md"

cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  list-workspaces) ;;
  new-workspace) echo "workspace:1" ;;
  list-pane-surfaces) echo 'surface:2' ;;
  rename-workspace|rename-tab|notify|send|send-key|wait-for|identify|new-split) ;;
  *) echo "unexpected cmux command: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/cmux"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/agmsg-send.sh"
chmod +x "$TMP/bin/agmsg-send.sh"

cat > "$TMP/runners.json" <<'JSON'
{"default":"claude","runners":[
  {"name":"claude","command":"claude","engine":"claude"},
  {"name":"codex","command":"codex","engine":"codex"}]}
JSON

# 既存 hook を先に置いて CI3 を検査できるようにする
cat > "$TMP/repo/.claude/settings.local.json" <<'EOF'
{"hooks":{"PostToolUse":[{"matcher":"ExitPlanMode","hooks":[{"type":"command","command":"zsh /x/plan-approved-hook.sh"}]}]}}
EOF

run_launch() { # $1=runner, $2=workspace name
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode execute --runner "$1" --role exec \
    --plan-file "$TMP/plan.md" --agmsg-team demo-team --agmsg-from task-exec \
    --status-dir "$TMP/status" --no-parallel "$2" >/dev/null 2>&1
}

gate_count() { # $1=検査するファイル
  jq '[.hooks.Stop[]?.hooks[]? | select(.command | test("completion-gate.sh"))] | length' \
    "$1" 2>/dev/null || echo 0
}

run_launch claude ci-1
n=$(gate_count "$TMP/repo/.claude/settings.local.json")
[[ "$n" == 1 ]] && pass 'CI1 Stop hook が 1 本入る' || bad "CI1 入っていない (n=$n)"

cmd=$(jq -r '[.hooks.Stop[]?.hooks[]? | select(.command | test("completion-gate.sh"))][0].command' \
  "$TMP/repo/.claude/settings.local.json" 2>/dev/null || echo "")
if [[ "$cmd" == *"--role 'exec'"* && "$cmd" == *"--agent 'task-exec'"* \
   && "$cmd" == *"--status-dir '$TMP/status'"* ]]; then
  pass 'CI1b 注入された command が role / agent / status-dir を持つ'
else
  bad "CI1b command の引数が違う: [$cmd]"
fi

run_launch claude ci-2
n=$(gate_count "$TMP/repo/.claude/settings.local.json")
[[ "$n" == 1 ]] && pass 'CI2 二重に入らない' || bad "CI2 重複した (n=$n)"

jq -e '.hooks.PostToolUse[0].matcher == "ExitPlanMode"' \
  "$TMP/repo/.claude/settings.local.json" >/dev/null 2>&1 \
  && pass 'CI3 既存の hook が残っている' || bad 'CI3 既存の hook を壊した'

# --- CI4/CI5/CI6: codex 側 ---
# .codex/hooks.json には agmsg が SessionStart を書いているので、壊さないことまで見る。
cat > "$TMP/repo/.codex/hooks.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"'/x/session-start.sh' 'codex' '/x'"}]}]}}
EOF

run_launch codex ci-4
n=$(gate_count "$TMP/repo/.codex/hooks.json")
[[ "$n" == 1 ]] && pass 'CI4 codex に Stop hook が 1 本入る' || bad "CI4 入っていない (n=$n)"

run_launch codex ci-5
n=$(gate_count "$TMP/repo/.codex/hooks.json")
[[ "$n" == 1 ]] && pass 'CI5 codex でも二重に入らない' || bad "CI5 重複した (n=$n)"

jq -e '.hooks.SessionStart[0].hooks[0].command | test("session-start.sh")' \
  "$TMP/repo/.codex/hooks.json" >/dev/null 2>&1 \
  && pass 'CI6 agmsg の SessionStart を壊さない' || bad 'CI6 agmsg の hook を壊した'

# --- CI7: 誤コミット防止 ---
exclude=$(git -C "$TMP/repo" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null)
ci7=1
for entry in '.claude/settings.local.json' '.codex/hooks.json'; do
  grep -qxF "$entry" "$exclude" 2>/dev/null || { bad "CI7 $entry が info/exclude に無い"; ci7=0; }
done
[[ $ci7 -eq 1 ]] && pass 'CI7 両方の設定ファイルが info/exclude に入る'

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
