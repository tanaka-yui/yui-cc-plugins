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
#   CI8.  注入された command に 'agmsg' が含まれない (agmsg の自エントリ判定と衝突しない)
#   CI9.  送信コマンドは <status-dir>/.send-command で渡り、gate の reason に出る
#   CI10. 同一 worktree・同一 engine で 2 ロールを起動しても取り違えない
#   CI11. 3.6.0 以前の「値を焼き込んだ entry」を置換する
#   CI12. 保存された command を実シェルで実行すると、環境から identity を解決する

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
# command は 4 ロールで共有される 1 本なので、ロールを焼き込んではならない。
# 焼き込むと後発ロールが先発ロールのゲートを実行する (2026-08-25 実測)。
if [[ "$cmd" != *"--role"* && "$cmd" != *"--agent"* && "$cmd" != *"--status-dir"* \
   && "$cmd" == *"--gate-id"* ]]; then
  pass 'CI1b command にロールを焼き込まない'
else
  bad "CI1b command にロールが焼き込まれている: [$cmd]"
fi

# ロールは runner script のプロセス環境から渡る。
runner="$TMP/repo/.cmux-team-dispatch-task-run-ci-1.sh"
if grep -q 'export DISPATCH_GATE_ROLE="exec"' "$runner" 2>/dev/null \
   && grep -q 'export DISPATCH_GATE_AGENT="task-exec"' "$runner" 2>/dev/null \
   && grep -q "export DISPATCH_GATE_STATUS_DIR=\"$TMP/status\"" "$runner" 2>/dev/null; then
  pass 'CI1c runner script がロールを export する'
else
  bad "CI1c runner script が DISPATCH_GATE_* を export していない"
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

# --- CI8: agmsg の自エントリ判定と衝突しない ---
# agmsg は delivery.sh status で「その Stop が自分の書いたものか」を command 文字列に
# 'agmsg' が含まれるかだけで判定する。gate の command に send.sh の実パスを埋めると
# 誤認され mode が both と報告され、codex-shim.sh (`mode: monitor` の完全一致を要求) が
# 素通しになって app-server bridge が起動しない。実際にこの経路で codex ペインが
# 受信不能になった (2026-08-24)。AGMSG_SEND のスタブ名にはわざと agmsg を含めてある。
ci8=1
for f in "$TMP/repo/.claude/settings.local.json" "$TMP/repo/.codex/hooks.json"; do
  c=$(jq -r '[.hooks.Stop[]?.hooks[]? | select(.command | test("completion-gate.sh"))][0].command' \
    "$f" 2>/dev/null || echo "")
  if [[ -z "$c" ]]; then
    bad "CI8 $f に gate の command が無い"; ci8=0
  elif [[ "$c" == *agmsg* ]]; then
    bad "CI8 $f の command に agmsg が含まれる: [$c]"; ci8=0
  fi
done
[[ $ci8 -eq 1 ]] && pass 'CI8 注入された command に agmsg が含まれない'

# --- CI9: 送信コマンドはファイルで渡る ---
GATE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/completion-gate.sh"
if [[ "$(cat "$TMP/status/.send-command" 2>/dev/null)" == "$TMP/bin/agmsg-send.sh" ]]; then
  # 判定 7 (作業途中で停止) を踏ませて reason に送信コマンドが載ることを見る。
  : > "$TMP/status/.assigned-task-exec"
  rm -f "$TMP/status/status.json" "$TMP/status/.gate-blocks"
  reason=$(bash "$GATE" --status-dir "$TMP/status" --role exec \
    --agent task-exec --team demo-team 2>/dev/null | jq -r '.reason // ""')
  if [[ "$reason" == *"$TMP/bin/agmsg-send.sh demo-team task-exec parent"* ]]; then
    pass 'CI9 .send-command から読んだ送信コマンドが reason に出る'
  else
    bad "CI9 reason に送信コマンドが無い: [$reason]"
  fi
else
  bad "CI9 .send-command が書かれていない"
fi

# --- CI7: 誤コミット防止 ---
exclude=$(git -C "$TMP/repo" rev-parse --path-format=absolute --git-path info/exclude 2>/dev/null)
ci7=1
for entry in '.claude/settings.local.json' '.codex/hooks.json'; do
  grep -qxF "$entry" "$exclude" 2>/dev/null || { bad "CI7 $entry が info/exclude に無い"; ci7=0; }
done
[[ $ci7 -eq 1 ]] && pass 'CI7 両方の設定ファイルが info/exclude に入る'

# --- CI10: 同一 worktree・同一 engine で 2 ロールを起動しても取り違えない ---
# 不具合の核心。settings.local.json は worktree に 1 本しか無いので gate も 1 本になり、
# ロールは runner script ごとの環境変数で分かれていなければならない。
run_launch_role() { # $1=runner $2=workspace-name $3=mode $4=role $5=agent
  # CMUX_BIN と RUNNERS_CONFIG_PATH は run_launch と同じく必須である。落とすと
  # launch-workspace.sh が PATH 上の**実物の cmux** を叩き、ユーザーの cmux に本物の
  # workspace を 2 つ作って本物の claude セッションを起動する。TUI は終了しないので
  # スイートはそこで止まり、EXIT trap が $TMP を消したあとにはペインだけが cwd を
  # 失った状態で残る (getcwd: cannot access parent directories)。
  CMUX_BIN="$TMP/bin/cmux" RUNNERS_CONFIG_PATH="$TMP/runners.json" \
  AGMSG_SEND="$TMP/bin/agmsg-send.sh" bash "$LAUNCH" \
    --cwd "$TMP/repo" --mode "$3" --runner "$1" --role "$4" \
    --plan-file "$TMP/plan.md" --agmsg-team demo-team --agmsg-from "$5" \
    --status-dir "$TMP/status" --no-parallel "$2" >/dev/null 2>&1
}
run_launch_role claude ci-10-exec execute exec task-exec
run_launch_role claude ci-10-review review exec_review task-exec-review
n=$(gate_count "$TMP/repo/.claude/settings.local.json")
r1=$(grep -o 'DISPATCH_GATE_ROLE="[^"]*"' "$TMP/repo/.cmux-team-dispatch-task-run-ci-10-exec.sh" 2>/dev/null | head -1)
r2=$(grep -o 'DISPATCH_GATE_ROLE="[^"]*"' "$TMP/repo/.cmux-team-dispatch-task-run-ci-10-review.sh" 2>/dev/null | head -1)
if [[ "$n" == 1 && "$r1" == 'DISPATCH_GATE_ROLE="exec"' \
   && "$r2" == 'DISPATCH_GATE_ROLE="exec_review"' ]]; then
  pass 'CI10 2 ロールでも gate は 1 本、ロールは runner ごとに分かれる'
else
  bad "CI10 gate=$n exec=[$r1] exec_review=[$r2]"
fi

# --- CI11: 3.6.0 以前の「値を焼き込んだ entry」を置換する ---
# 古い entry を残すと、そちらが先発ロールの値で全ペインを縛り続ける。
jq '.hooks.Stop = [{matcher:"",hooks:[{type:"command",
      command:"zsh /old/skills/scripts/completion-gate.sh --status-dir /old --role design --agent other"}]}]' \
  "$TMP/repo/.claude/settings.local.json" > "$TMP/ci11.json" 2>/dev/null \
  && mv "$TMP/ci11.json" "$TMP/repo/.claude/settings.local.json"
run_launch claude ci-11
n=$(gate_count "$TMP/repo/.claude/settings.local.json")
cmd=$(jq -r '[.hooks.Stop[]?.hooks[]? | select(.command | test("completion-gate.sh"))][0].command' \
  "$TMP/repo/.claude/settings.local.json" 2>/dev/null || echo "")
if [[ "$n" == 1 && "$cmd" != *"--role design"* && "$cmd" == *"--gate-id"* ]]; then
  pass 'CI11 旧形式の entry を新形式へ置換する'
else
  bad "CI11 migration されていない n=$n cmd=[$cmd]"
fi

# --- CI12: 保存された command を実シェルで実行し、環境から identity を解決できる ---
# engine が Stop hook を起動するとき親プロセスの環境を継承することは、2026-08-26 に
# claude (claude -p) と codex (codex exec) の両方で実測済み。ここで固定するのは
# 「保存された command 文字列が、その環境で実際に動くか」である。command を組み立て直す
# 変更 (クォートの入れ子、引数の増減) が入っても、ここで落ちる。
run_launch claude ci-12
cmd=$(jq -r '[.hooks.Stop[]?.hooks[]? | select(.command | test("completion-gate.sh"))][0].command' \
  "$TMP/repo/.claude/settings.local.json" 2>/dev/null || echo "")
mkdir -p "$TMP/ci12/review"
printf '{"status":"executing"}\n' > "$TMP/ci12/status.json"
: > "$TMP/ci12/.assigned-task-exec"
out=$(DISPATCH_GATE_STATUS_DIR="$TMP/ci12" DISPATCH_GATE_ROLE=exec DISPATCH_GATE_AGENT=task-exec \
  eval "$cmd" 2>/dev/null)
if [[ -n "$out" ]] && jq -e '.decision == "block"' >/dev/null 2>&1 <<< "$out"; then
  pass 'CI12 保存された command が環境から identity を解決する'
else
  bad "CI12 command が環境から解決できない: [$out]"
fi

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
